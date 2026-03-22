#!/usr/bin/env node
// WhatsApp QR RPC test — runs inside the Docker container (ES module)
// Usage: GATEWAY_TOKEN=xxx node test-whatsapp-rpc.mjs

import { WebSocket } from 'ws';

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || 'test-token-abc123';
const WS_URL = `ws://127.0.0.1:18789?token=${GATEWAY_TOKEN}`;

const ws = new WebSocket(WS_URL, {
  headers: { Origin: 'http://127.0.0.1:18789' },
});

const connectId = 'connect-1';
const rpcId = 'login-start-1';
let done = false;

const timeout = setTimeout(() => {
  if (!done) {
    done = true;
    process.stdout.write(JSON.stringify({ error: 'TIMEOUT: No response within 45s' }) + '\n');
    ws.close();
    process.exit(1);
  }
}, 45000);

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'req', id: connectId, method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'openclaw-control-ui', version: 'blink-claw/1.0', platform: 'linux', mode: 'webchat' },
      role: 'operator', scopes: ['operator.admin'],
      auth: { token: GATEWAY_TOKEN },
      locale: 'en-US', userAgent: 'blink-claw/1.0',
    },
  }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'res' && msg.id === connectId) {
    if (!msg.ok) {
      done = true;
      process.stdout.write(JSON.stringify({ error: 'Auth failed: ' + (msg.error?.message || 'unknown') }) + '\n');
      clearTimeout(timeout);
      ws.close();
      process.exit(1);
      return;
    }
    ws.send(JSON.stringify({
      type: 'req', id: rpcId, method: 'web.login.start',
      params: { accountId: 'default', force: false, timeoutMs: 30000 },
    }));
  }

  if (msg.type === 'res' && msg.id === rpcId) {
    done = true;
    clearTimeout(timeout);
    if (msg.ok) {
      const payload = msg.payload || {};
      process.stdout.write(JSON.stringify({
        success: true,
        hasQrDataUrl: !!payload.qrDataUrl,
        message: payload.message || '',
        qrLength: payload.qrDataUrl ? payload.qrDataUrl.length : 0,
      }) + '\n');
      ws.close();
      process.exit(0);
    } else {
      process.stdout.write(JSON.stringify({ error: msg.error?.message || 'RPC failed' }) + '\n');
      ws.close();
      process.exit(1);
    }
  }
});

ws.on('error', (err) => {
  if (!done) {
    done = true;
    clearTimeout(timeout);
    process.stdout.write(JSON.stringify({ error: 'WS error: ' + err.message }) + '\n');
    ws.close();
    process.exit(1);
  }
});
