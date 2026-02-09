import { randomUUID } from "crypto";
// Trigger skills.status via Gateway WebSocket to force Guard evaluation.
// Usage: node trigger-skills-status.mjs [password] [port]
//
// Uses createRequire to resolve 'ws' from the atd worktree's node_modules,
// since ESM import resolution is based on script location, not CWD.
import { createRequire } from "module";

// Resolve 'ws' from CWD (allows running from the atd worktree dir where ws is installed)
const require = createRequire(process.cwd() + "/");
const { WebSocket } = require("ws");

// Auth argument: "token:VALUE" or "password:VALUE" or just "VALUE" (treated as password for compat)
const authArg = process.argv[2] || "password:dev";
const [authType, authValue] = authArg.includes(":")
  ? [authArg.split(":")[0], authArg.slice(authArg.indexOf(":") + 1)]
  : ["password", authArg];
const port = process.argv[3] || "18789";
const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://localhost:${port}` });

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "event" && msg.event === "connect.challenge") {
    ws.send(
      JSON.stringify({
        type: "req",
        method: "connect",
        id: randomUUID(),
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "test", version: "dev", platform: "linux", mode: "test" },
          caps: [],
          role: "operator",
          scopes: ["operator.admin"],
          auth: authType === "token" ? { token: authValue } : { password: authValue },
        },
      }),
    );
  } else if (msg.type === "res" && msg.ok && msg.payload?.hello) {
    ws.send(JSON.stringify({ type: "req", method: "skills.status", id: randomUUID() }));
  } else if (msg.type === "res" && msg.ok && msg.payload?.skills) {
    const skills = msg.payload.skills;
    const blocked = skills.filter((s) => s.guardBlocked).map((s) => s.name);
    console.log(JSON.stringify({ count: skills.length, blocked }));
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});
setTimeout(() => {
  ws.close();
  process.exit(1);
}, 30000);
