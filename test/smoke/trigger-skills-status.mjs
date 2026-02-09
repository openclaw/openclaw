// Trigger skills.status via Gateway WebSocket to force Guard evaluation.
// Usage: node trigger-skills-status.mjs [password] [port]
import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const password = process.argv[2] || 'dev';
const port = process.argv[3] || '19001';
const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://localhost:${port}` });

ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
        ws.send(JSON.stringify({
            type: 'req', method: 'connect', id: randomUUID(),
            params: {
                minProtocol: 3, maxProtocol: 3,
                client: { id: 'test', version: 'dev', platform: 'linux', mode: 'test' },
                caps: [], role: 'operator', scopes: ['operator.admin'],
                auth: { password }
            }
        }));
    } else if (msg.type === 'res' && msg.ok && msg.payload?.hello) {
        ws.send(JSON.stringify({ type: 'req', method: 'skills.status', id: randomUUID() }));
    } else if (msg.type === 'res' && msg.ok && msg.payload?.skills) {
        const skills = msg.payload.skills;
        const blocked = skills.filter(s => s.guardBlocked).map(s => s.name);
        console.log(JSON.stringify({ count: skills.length, blocked }));
        ws.close();
        process.exit(0);
    }
});
ws.on('error', () => process.exit(1));
setTimeout(() => { ws.close(); process.exit(1); }, 30000);
