'use strict';
/*
 * Coup Online — authoritative game server.
 * Clients only send intents; the server validates everything and sends
 * each player ONLY their own hidden cards.
 * House rules (Ali's): NO Foreign Aid, coin cap = 9, 30s server-controlled
 * challenge/block windows, unlimited normal turns and card decisions.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const COIN_CAP = 9;
const WINDOW_MS = 30000;
const ROLES = ['duke', 'assassin', 'ambassador', 'captain', 'contessa'];
const ROLE_AR = { duke: 'الدوق', assassin: 'القاتل', ambassador: 'السفير', captain: 'القائد', contessa: 'الكونتيسة' };
const CARD_IMG = r => '/assets/card-' + r + '.webp'; // Ali's original card artwork, cropped from his upload

const rooms = new Map();
let cardSeq = 1;

/* ---------------- helpers ---------------- */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(c));
  return c;
}
function getPlayer(room, token) { return room.players.find(p => p.token === token); }
function aliveOthers(room, token) { return room.players.filter(p => p.alive && p.token !== token); }
function currentPlayer(room) { return room.players[room.turnIdx]; }
function addLog(room, text, sfx) {
  room.log.push({ text, sfx: sfx || null, id: ++room.logSeq });
  if (room.log.length > 50) room.log.shift();
}
function newPlayer(token, name) {
  return { token, name, socketId: null, connected: false, coins: 0, cards: [], alive: false, voice: false };
}
function newRoom(code, host) {
  return {
    code, hostToken: host.token, phase: 'lobby', players: [host],
    deck: [], turnIdx: 0, window: null, timer: null, pending: null,
    loseDecision: null, loseNext: null, exchange: null,
    winner: null, reveal: null, announce: '', log: [], logSeq: 0
  };
}

/* ---------------- state (personalized per player) ---------------- */
function buildState(room, me) {
  const turn = room.phase === 'playing' ? currentPlayer(room) : null;
  const w = room.window;
  return {
    code: room.code,
    phase: room.phase,
    myToken: me.token,
    isHost: room.hostToken === me.token,
    announce: room.announce,
    reveal: room.reveal,
    winnerToken: room.winner,
    winner: room.winner ? (getPlayer(room, room.winner) || {}).name : null,
    players: room.players.map(p => ({
      id: p.token,
      name: p.name,
      coins: p.coins,
      alive: p.alive,
      connected: p.connected,
      voice: p.voice,
      isHost: room.hostToken === p.token,
      isTurn: !!(turn && turn.token === p.token),
      // opponents only ever see revealed roles — hidden cards carry NO role
      cards: p.cards.map(c => (c.revealed ? { revealed: true, role: c.role, img: CARD_IMG(c.role) } : { revealed: false })),
      hiddenCount: p.cards.filter(c => !c.revealed).length
    })),
    me: {
      coins: me.coins,
      alive: me.alive,
      cards: me.cards.map(c => ({ id: c.id, role: c.role, revealed: c.revealed, img: CARD_IMG(c.role) }))
    },
    turnId: turn ? turn.token : null,
    turnName: turn ? turn.name : null,
    myTurn: !!(turn && turn.token === me.token && !room.window && !room.loseDecision && !room.exchange),
    atCap: me.coins >= COIN_CAP,
    window: w ? {
      kind: w.kind,
      deadline: w.deadline, // server timestamp — clients render countdown from this
      claim: w.claim,
      blockClaim: w.blockClaim || null,
      claimBy: (getPlayer(room, w.claimBy) || {}).name || '',
      actionType: w.actionType || null,
      targetName: w.targetToken ? ((getPlayer(room, w.targetToken) || {}).name || '') : null,
      eligible: w.eligible.includes(me.token),
      myResponse: w.responses[me.token] || null,
      claims: w.claims || null,
      passedCount: Object.values(w.responses).filter(r => r === 'pass').length,
      eligibleCount: w.eligible.length
    } : null,
    lose: room.loseDecision ? {
      mine: room.loseDecision.player === me.token,
      name: (getPlayer(room, room.loseDecision.player) || {}).name || ''
    } : null,
    exchange: room.exchange ? (room.exchange.player === me.token
      ? { mine: true, hand: room.exchange.hand.map(c => ({ id: c.id, role: c.role, img: CARD_IMG(c.role) })), keepCount: room.exchange.keepCount }
      : { mine: false, name: (getPlayer(room, room.exchange.player) || {}).name || '' }) : null,
    log: room.log.slice(-10)
  };
}
function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('state', buildState(room, p));
    }
  }
}

/* ---------------- 30-second response windows (server-controlled) ---------------- */
function openWindow(room, w) {
  w.deadline = Date.now() + WINDOW_MS; // original deadline — reconnects never change it
  w.responses = {};
  room.window = w;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => finishWindow(room), WINDOW_MS + 100);
  broadcast(room);
}
function finishWindow(room) {
  const w = room.window;
  if (!w) return;
  room.window = null;
  clearTimeout(room.timer);
  w.resolve(w); // non-responders simply have no entry => counted as passed
}

/* ---------------- losing an influence (NO time limit) ---------------- */
function askLose(room, player, next) {
  if (!player || !player.alive) { if (next) next(); return; }
  // if the player has exactly one hidden card there is no real choice, but we
  // still let them tap it (decision stays open until they respond).
  room.loseDecision = { player: player.token };
  room.loseNext = next;
  room.announce = `${player.name} يختار بطاقة ليخسرها`;
  broadcast(room);
}
function doLose(room, player, cardId) {
  const card = player.cards.find(c => c.id === cardId && !c.revealed);
  if (!card) return false;
  card.revealed = true;
  const remaining = player.cards.filter(c => !c.revealed).length;
  if (remaining === 0) {
    player.alive = false;
    addLog(room, `💀 ${player.name} خسر بطاقة ${ROLE_AR[card.role]} وطلع من اللعبة!`, 'eliminate');
  } else {
    addLog(room, `${player.name} خسر بطاقة ${ROLE_AR[card.role]}`, 'cardlose');
  }
  room.loseDecision = null;
  const next = room.loseNext;
  room.loseNext = null;
  if (checkWinner(room)) { broadcast(room); return true; }
  broadcast(room);
  if (next) next();
  return true;
}
function checkWinner(room) {
  const alive = room.players.filter(p => p.alive);
  if (room.phase === 'playing' && alive.length === 1) {
    room.phase = 'finished';
    room.winner = alive[0].token;
    room.announce = `🏆 ${alive[0].name} فاز باللعبة!`;
    addLog(room, `🏆 ${alive[0].name} فاز باللعبة!`, 'end');
    return true;
  }
  return false;
}

/* ---------------- challenge resolution ---------------- */
function openChallengeWindow(room, opts) {
  // opts: {claimBy, claim, actionType, targetToken, eligible[], announceText, onProceed, onFail}
  room.announce = opts.announceText;
  openWindow(room, {
    kind: opts.kind || 'challenge',
    claimBy: opts.claimBy,
    claim: opts.claim,
    actionType: opts.actionType || null,
    targetToken: opts.targetToken || null,
    eligible: opts.eligible,
    resolve(w) {
      const challengerTok = Object.keys(w.responses).find(t => w.responses[t] === 'challenge');
      if (!challengerTok) { opts.onProceed(); return; }
      const challenger = getPlayer(room, challengerTok);
      const claimant = getPlayer(room, opts.claimBy);
      const card = claimant.cards.find(c => !c.revealed && c.role === opts.claim);
      if (card) {
        // claimant really holds it: reveal, challenger loses one, claimant swaps card
        room.reveal = { name: claimant.name, role: opts.claim, ok: true };
        addLog(room, `⚔️ ${challenger.name} تحدّى ${claimant.name} — كشف ${ROLE_AR[opts.claim]}! التحدي فشل`, 'bell');
        room.deck.push(card.role);
        shuffle(room.deck);
        card.role = room.deck.pop();
        room.announce = `${claimant.name} كشف ${ROLE_AR[opts.claim]} — ${challenger.name} يخسر بطاقة`;
        broadcast(room);
        askLose(room, challenger, () => { room.reveal = null; opts.onProceed(); });
      } else {
        room.reveal = { name: claimant.name, role: opts.claim, ok: false };
        addLog(room, `⚔️ ${challenger.name} تحدّى ${claimant.name} — ما عنده ${ROLE_AR[opts.claim]}! التحدي نجح`, 'bell');
        room.announce = `${claimant.name} انكشف — يخسر بطاقة`;
        broadcast(room);
        askLose(room, claimant, () => { room.reveal = null; opts.onFail(); });
      }
    }
  });
}

/* ---------------- turn flow ---------------- */
function endTurn(room) {
  room.pending = null;
  room.reveal = null;
  if (room.phase !== 'playing') { broadcast(room); return; }
  const n = room.players.length;
  let i = room.turnIdx;
  do { i = (i + 1) % n; } while (!room.players[i].alive);
  room.turnIdx = i;
  room.announce = `دور ${room.players[i].name}`;
  broadcast(room);
}

function proceedAction(room, act) {
  // the action claim survived its challenge window
  const actor = getPlayer(room, act.actor);
  if (!actor || !actor.alive) { endTurn(room); return; }
  if (act.type === 'tax') {
    const gain = Math.min(3, COIN_CAP - actor.coins); // gains truncated at cap 9
    actor.coins += gain;
    addLog(room, `💰 ${actor.name} أخذ الضريبة +${gain} (صار عنده ${actor.coins})`, 'coins');
    endTurn(room);
  } else if (act.type === 'exchange') {
    startExchange(room, actor);
  } else if (act.type === 'steal' || act.type === 'assassinate') {
    openBlockWindow(room, act);
  }
}

function openBlockWindow(room, act) {
  const actor = getPlayer(room, act.actor);
  const target = getPlayer(room, act.target);
  if (!target || !target.alive) { endTurn(room); return; }
  const claims = act.type === 'steal' ? ['captain', 'ambassador'] : ['contessa'];
  room.announce = act.type === 'steal'
    ? `${actor.name} يحاول يسرق من ${target.name} — بس ${target.name} يگدر يمنع`
    : `${actor.name} يحاول يغتال ${target.name} — بس ${target.name} يگدر يمنع بالكونتيسة`;
  openWindow(room, {
    kind: 'block',
    claimBy: act.actor,
    claim: act.claim,
    actionType: act.type,
    targetToken: act.target,
    eligible: [target.token], // ONLY the target may block
    claims,
    resolve(w) {
      if (w.responses[target.token] === 'block') {
        const bc = w.blockClaim;
        addLog(room, `🛡️ ${target.name} منع بادّعاء ${ROLE_AR[bc]}`, 'shield');
        openChallengeWindow(room, {
          kind: 'blockChallenge',
          claimBy: target.token,
          claim: bc,
          actionType: act.type,
          targetToken: act.target,
          eligible: aliveOthers(room, target.token).map(p => p.token),
          announceText: `${target.name} ادّعى ${ROLE_AR[bc]} للمنع — أحد يتحدّى؟`,
          onProceed() {
            addLog(room, `🛡️ منع ${target.name} نجح — الإجراء تلغى`, 'shield');
            endTurn(room);
          },
          onFail() {
            // block was a bluff: blocker lost a card, original action proceeds
            applyTargetAction(room, act);
          }
        });
      } else {
        applyTargetAction(room, act);
      }
    }
  });
}

function applyTargetAction(room, act) {
  const actor = getPlayer(room, act.actor);
  const target = getPlayer(room, act.target);
  if (!target || !target.alive || !actor) { endTurn(room); return; }
  if (act.type === 'steal') {
    const amount = Math.max(0, Math.min(2, target.coins, COIN_CAP - actor.coins));
    target.coins -= amount;
    actor.coins += amount;
    addLog(room, `🕵️ ${actor.name} سرق ${amount} من ${target.name}`, 'coins');
    endTurn(room);
  } else if (act.type === 'assassinate') {
    addLog(room, `🗡️ ${actor.name} اغتال بطاقة من ${target.name}`, 'stab');
    askLose(room, target, () => endTurn(room));
  }
}

/* ---------------- Ambassador exchange (NO time limit) ---------------- */
function startExchange(room, actor) {
  const drawn = [];
  for (let i = 0; i < 2 && room.deck.length > 0; i++) {
    drawn.push({ id: cardSeq++, role: room.deck.pop(), revealed: false });
  }
  const hidden = actor.cards.filter(c => !c.revealed);
  room.exchange = {
    player: actor.token,
    hand: hidden.concat(drawn),
    keepCount: hidden.length
  };
  room.announce = `${actor.name} يبدّل بطاقاته (السفير) — يختار بدون حدّ وقتي`;
  addLog(room, `🔄 ${actor.name} بدّل بطاقاته ويا مجموعة البلاط`, 'shuffle');
  broadcast(room);
}
function doExchange(room, player, keepIds) {
  const ex = room.exchange;
  if (!ex || ex.player !== player.token) return 'مو تبديلك';
  if (!Array.isArray(keepIds) || keepIds.length !== ex.keepCount) return 'عدد البطاقات غير صحيح';
  if (new Set(keepIds).size !== keepIds.length) return 'بطاقات مكررة';
  const byId = new Map(ex.hand.map(c => [c.id, c]));
  if (!keepIds.every(id => byId.has(id))) return 'بطاقة غير موجودة';
  const kept = keepIds.map(id => byId.get(id));
  const returned = ex.hand.filter(c => !keepIds.includes(c.id));
  for (const c of returned) room.deck.push(c.role);
  shuffle(room.deck);
  player.cards = player.cards.filter(c => c.revealed).concat(kept);
  room.exchange = null;
  addLog(room, `🔄 ${player.name} كمّل التبديل`, null);
  endTurn(room);
  return null;
}

/* ---------------- actions (client intents, fully validated) ---------------- */
function doAction(room, player, data) {
  if (room.phase !== 'playing') return 'اللعبة ما بدت بعد';
  if (room.window || room.loseDecision || room.exchange) return 'انتظر نهاية الخطوة الحالية';
  if (currentPlayer(room).token !== player.token) return 'مو دورك';
  if (!player.alive) return 'أنت خارج اللعبة';
  const type = data && data.type;
  const target = data && data.target ? getPlayer(room, data.target) : null;
  const needTarget = ['steal', 'assassinate', 'coup'].includes(type);
  if (needTarget && (!target || !target.alive || target.token === player.token)) return 'هدف غير صالح';
  // Coin-cap rule: starting your turn at 9 => no Income/Tax/Steal at all.
  if (player.coins >= COIN_CAP && ['income', 'tax', 'steal'].includes(type)) {
    return 'عندك ٩ نقاط (الحد الأقصى) — لازم تلعب ببطاقة (اغتيال/تبديل) أو تسوي انقلاب';
  }
  room.reveal = null;
  switch (type) {
    case 'income': {
      player.coins = Math.min(COIN_CAP, player.coins + 1);
      addLog(room, `💰 ${player.name} أخذ دخل +1 (صار عنده ${player.coins})`, 'coins');
      endTurn(room);
      return null;
    }
    case 'coup': {
      if (player.coins < 7) return 'الانقلاب يحتاج ٧ نقاط';
      player.coins -= 7;
      addLog(room, `💥 ${player.name} سوّى انقلاب على ${target.name}`, 'boom');
      askLose(room, target, () => endTurn(room));
      return null;
    }
    case 'tax':
    case 'steal':
    case 'exchange':
    case 'assassinate': {
      const claim = { tax: 'duke', steal: 'captain', exchange: 'ambassador', assassinate: 'assassin' }[type];
      if (type === 'assassinate') {
        if (player.coins < 3) return 'الاغتيال يحتاج ٣ نقاط';
        player.coins -= 3; // paid up-front; never refunded even if blocked/challenged
      }
      const act = { actor: player.token, type, claim, target: target ? target.token : null };
      room.pending = act;
      let claimText;
      if (type === 'tax') claimText = `${player.name} ادّعى الدوق — ضريبة +٣`;
      else if (type === 'steal') claimText = `${player.name} ادّعى القائد — سرقة من ${target.name}`;
      else if (type === 'exchange') claimText = `${player.name} ادّعى السفير — تبديل بطاقات`;
      else claimText = `${player.name} ادّعى القاتل — اغتيال ${target.name} (دفع ٣)`;
      addLog(room, `🎭 ${claimText}`, null);
      openChallengeWindow(room, {
        claimBy: player.token,
        claim,
        actionType: type,
        targetToken: act.target,
        eligible: aliveOthers(room, player.token).map(p => p.token),
        announceText: claimText + ' — أحد يتحدّى؟',
        onProceed() { proceedAction(room, act); },
        onFail() {
          addLog(room, `❌ إجراء ${player.name} فشل`, null);
          endTurn(room);
        }
      });
      return null;
    }
    default:
      // NOTE: there is deliberately NO 'foreignaid' action in this game.
      return 'إجراء غير معروف';
  }
}

function startGame(room) {
  room.deck = shuffle(ROLES.flatMap(r => [r, r, r])); // 15 cards, 3 of each
  for (const p of room.players) {
    p.coins = 2;
    p.alive = true;
    p.cards = [
      { id: cardSeq++, role: room.deck.pop(), revealed: false },
      { id: cardSeq++, role: room.deck.pop(), revealed: false }
    ];
  }
  room.phase = 'playing';
  room.winner = null;
  room.window = null;
  room.loseDecision = null;
  room.loseNext = null;
  room.exchange = null;
  room.pending = null;
  room.reveal = null;
  room.turnIdx = 0;
  room.log = [];
  addLog(room, '🎬 بدت اللعبة! كل لاعب عنده نقطتين وبطاقتين', null);
  room.announce = `دور ${room.players[0].name}`;
  broadcast(room);
}

/* ---------------- socket plumbing ---------------- */
function ctx(socket) {
  const code = socket.data.roomCode;
  const token = socket.data.token;
  if (!code || !token) return {};
  const room = rooms.get(code);
  if (!room) return {};
  const player = getPlayer(room, token);
  if (!player) return {};
  return { room, player };
}
function bind(socket, room, player) {
  player.socketId = socket.id;
  player.connected = true;
  socket.data.roomCode = room.code;
  socket.data.token = player.token;
  socket.join(room.code);
}
function detachFromLobbyRooms(token, exceptCode) {
  // if the token sits in a *lobby* room elsewhere, free that seat
  for (const [code, r] of rooms) {
    if (code === exceptCode) continue;
    const idx = r.players.findIndex(p => p.token === token);
    if (idx === -1) continue;
    if (r.phase === 'lobby') {
      const wasHost = r.hostToken === token;
      r.players.splice(idx, 1);
      if (r.players.length === 0) rooms.delete(code);
      else {
        if (wasHost) r.hostToken = r.players[0].token;
        broadcast(r);
      }
    }
  }
}
function findSeat(token) {
  for (const r of rooms.values()) {
    const p = getPlayer(r, token);
    if (p) return { room: r, player: p };
  }
  return null;
}

io.on('connection', (socket) => {
  socket.on('createRoom', (data) => {
    const name = String((data && data.name) || '').trim().slice(0, 20);
    const token = String((data && data.token) || '');
    if (!name || !token) { socket.emit('errorMsg', 'اكتب اسمك أولاً'); return; }
    const seat = findSeat(token);
    if (seat && seat.room.phase !== 'lobby') { socket.emit('errorMsg', 'أنت داخل لعبة جارية'); return; }
    detachFromLobbyRooms(token);
    const player = newPlayer(token, name);
    const code = makeCode();
    const room = newRoom(code, player);
    rooms.set(code, room);
    bind(socket, room, player);
    socket.emit('joined', { code });
    broadcast(room);
  });

  socket.on('joinRoom', (data) => {
    const name = String((data && data.name) || '').trim().slice(0, 20);
    const token = String((data && data.token) || '');
    const code = String((data && data.code) || '').trim().toUpperCase();
    if (!name || !token || !code) { socket.emit('errorMsg', 'اكتب اسمك وكود الغرفة'); return; }
    const room = rooms.get(code);
    if (!room) { socket.emit('errorMsg', 'الغرفة غير موجودة'); return; }
    const existing = getPlayer(room, token);
    if (existing) { // seat restore / rejoin
      bind(socket, room, existing);
      socket.emit('joined', { code });
      broadcast(room);
      return;
    }
    if (room.phase !== 'lobby') { socket.emit('errorMsg', 'اللعبة بدت — ما تگدر تنضم هسه'); return; }
    if (room.players.length >= 6) { socket.emit('errorMsg', 'الغرفة مليانة (٦ لاعبين كحد أقصى)'); return; }
    detachFromLobbyRooms(token, code);
    const player = newPlayer(token, name);
    room.players.push(player);
    bind(socket, room, player);
    addLog(room, `👋 ${name} انضم للغرفة`, null);
    socket.emit('joined', { code });
    broadcast(room);
  });

  socket.on('rejoin', (data) => {
    const token = String((data && data.token) || '');
    const code = String((data && data.code) || '').trim().toUpperCase();
    const room = rooms.get(code);
    const player = room && getPlayer(room, token);
    if (!room || !player) { socket.emit('rejoinFailed'); return; }
    bind(socket, room, player);
    socket.emit('joined', { code });
    broadcast(room); // window deadlines live in room state => original 30s deadline preserved
  });

  socket.on('startGame', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.hostToken !== player.token) { socket.emit('errorMsg', 'بس المضيف يگدر يبدي اللعبة'); return; }
    if (room.phase !== 'lobby') return;
    if (room.players.length < 2) { socket.emit('errorMsg', 'لازم لاعبين على الأقل'); return; }
    startGame(room);
  });

  socket.on('restart', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.hostToken !== player.token) { socket.emit('errorMsg', 'بس المضيف يگدر يعيد اللعبة'); return; }
    if (room.phase !== 'finished') return;
    startGame(room);
  });

  socket.on('action', (data) => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    const err = doAction(room, player, data || {});
    if (err) socket.emit('errorMsg', err);
  });

  socket.on('respond', (data) => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    const w = room.window;
    if (!w) return;
    if (!w.eligible.includes(player.token)) return; // not eligible in this window
    if (w.responses[player.token]) return; // already answered
    const response = data && data.response;
    if (w.kind === 'challenge' || w.kind === 'blockChallenge') {
      if (response === 'challenge') {
        w.responses[player.token] = 'challenge';
        finishWindow(room); // a valid challenge resolves the window immediately
      } else if (response === 'pass') {
        w.responses[player.token] = 'pass';
        if (w.eligible.every(t => w.responses[t])) finishWindow(room); // all passed => no waiting
        else broadcast(room);
      }
    } else if (w.kind === 'block') {
      if (response === 'block') {
        const bc = data && data.blockClaim;
        if (!w.claims.includes(bc)) { socket.emit('errorMsg', 'ادّعاء منع غير صالح'); return; }
        w.responses[player.token] = 'block';
        w.blockClaim = bc;
        finishWindow(room);
      } else if (response === 'pass') {
        w.responses[player.token] = 'pass';
        finishWindow(room);
      }
    }
  });

  socket.on('loseCard', (data) => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (!room.loseDecision || room.loseDecision.player !== player.token) return;
    const cardId = data && data.cardId;
    if (!doLose(room, player, cardId)) socket.emit('errorMsg', 'بطاقة غير صالحة');
  });

  socket.on('exchangeKeep', (data) => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    const err = doExchange(room, player, data && data.keepIds);
    if (err) socket.emit('errorMsg', err);
  });

  /* -------- voice chat: WebRTC mesh, signaling relayed via socket.io -------- */
  socket.on('voiceOn', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    player.voice = true;
    socket.to(room.code).emit('voicePeerOn', { playerId: player.token });
    broadcast(room);
  });
  socket.on('voiceOff', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    player.voice = false;
    socket.to(room.code).emit('voicePeerOff', { playerId: player.token });
    broadcast(room);
  });
  function relay(event) {
    socket.on(event, (data) => {
      const { room, player } = ctx(socket);
      if (!room || !player || !data || !data.to) return;
      const target = getPlayer(room, data.to);
      if (target && target.socketId) {
        io.to(target.socketId).emit(event, { from: player.token, sdp: data.sdp, candidate: data.candidate });
      }
    });
  }
  relay('voiceOffer');
  relay('voiceAnswer');
  relay('voiceIce');

  socket.on('disconnect', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (player.socketId !== socket.id) return; // a newer socket already owns the seat
    player.connected = false; // seat is KEPT — the player can rejoin anytime
    player.socketId = null;
    if (player.voice) {
      player.voice = false;
      socket.to(room.code).emit('voicePeerOff', { playerId: player.token });
    }
    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`Coup Online server running on http://localhost:${PORT}`);
});
