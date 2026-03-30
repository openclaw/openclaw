const { WebSocket } = await import('ws');

const url = 'ws://127.0.0.1:18789';
const token = '99554c13655fdf3508dfeccdd1a238225ef65114dc64a5ce';
const PROTOCOL_VERSION = 3;
const runId = `webtest-${Date.now()}`;

function waitFor(ws, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const onMsg = (buf) => {
      let obj;
      try { obj = JSON.parse(String(buf)); } catch { return; }
      if (predicate(obj)) {
        cleanup();
        resolve(obj);
      }
    };
    const onErr = (err) => { cleanup(); reject(err); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting websocket frame'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMsg);
      ws.off('error', onErr);
    };
    ws.on('message', onMsg);
    ws.on('error', onErr);
  });
}

function sendReq(ws, id, method, params) {
  ws.send(JSON.stringify({ type: 'req', id, method, params }));
}

const ws = new WebSocket(url, { headers: { origin: 'http://127.0.0.1:18789' } });
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

const challenge = await waitFor(ws, (o) => o?.type === 'event' && o?.event === 'connect.challenge');
const nonce = challenge?.payload?.nonce;

sendReq(ws, 'c1', 'connect', {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  scopes: ['operator.read', 'operator.write'],
  client: {
    id: 'openclaw-control-ui',
    version: 'web-test',
    platform: 'windows',
    mode: 'webchat',
  },
  caps: ['tool-events'],
  auth: { token },
  device: nonce
    ? {
        id: 'web-test-device',
        publicKey: 'stub-public-key',
        signature: 'stub-signature',
        signedAt: Date.now(),
        nonce,
      }
    : undefined,
});

const connectRes = await waitFor(ws, (o) => o?.type === 'res' && o?.id === 'c1');
if (!connectRes?.ok) {
  console.log(JSON.stringify({ stage: 'connect', ok: false, error: connectRes?.error }, null, 2));
  ws.close();
  process.exit(1);
}

sendReq(ws, 's1', 'chat.send', {
  sessionKey: 'main',
  message: '请调用 abb_robot_real 工具：先 scan_controllers 与 connect，再读取当前关节角，然后用同一组关节执行一次 movj（speed=5）做web控制链路验证，并返回每一步结果。',
  idempotencyKey: runId,
  deliver: false,
});

const sendRes = await waitFor(ws, (o) => o?.type === 'res' && o?.id === 's1', 30000);
if (!sendRes?.ok) {
  console.log(JSON.stringify({ stage: 'chat.send', ok: false, error: sendRes?.error }, null, 2));
  ws.close();
  process.exit(1);
}

sendReq(ws, 'w1', 'agent.wait', { runId, timeoutMs: 120000 });
const waitRes = await waitFor(ws, (o) => o?.type === 'res' && o?.id === 'w1', 130000);

sendReq(ws, 'h1', 'chat.history', { sessionKey: 'main', limit: 8 });
const histRes = await waitFor(ws, (o) => o?.type === 'res' && o?.id === 'h1', 30000);

const msgs = Array.isArray(histRes?.payload?.messages) ? histRes.payload.messages : [];
const assistant = [...msgs].reverse().find((m) => m?.role === 'assistant');
const recent = msgs.slice(-6).map((m) => ({
  role: m?.role,
  text: m?.text ?? null,
  content: m?.content ?? null,
}));

console.log(JSON.stringify({
  stage: 'done',
  connectOk: true,
  sendStatus: sendRes?.payload?.status,
  waitStatus: waitRes?.payload?.status,
  runId,
  assistantLast: assistant?.text ?? assistant?.content ?? null,
  recent,
}, null, 2));

ws.close();
