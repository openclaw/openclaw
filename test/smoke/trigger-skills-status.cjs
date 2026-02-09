#!/usr/bin/env node
// Trigger skills.status via Gateway WebSocket to force Guard evaluation.
// Usage: node trigger-skills-status.cjs [password] [port]
//
// Connects to the Gateway WebSocket, authenticates, sends a skills.status
// request, and outputs the result as JSON.
// Requires 'ws' package — set NODE_PATH or run from a directory that has it.

const { WebSocket } = require("ws");
const { randomUUID } = require("crypto");

// Auth argument: "token:VALUE" or "password:VALUE" or just "VALUE" (treated as password for compat)
const authArg = process.argv[2] || "password:dev";
const [authType, authValue] = authArg.includes(":")
  ? [authArg.split(":")[0], authArg.slice(authArg.indexOf(":") + 1)]
  : ["password", authArg];
const port = process.argv[3] || "18789";
const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://localhost:${port}` });

let connectSent = false;
let skillsStatusSent = false;

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  // Step 1: Respond to connect.challenge with credentials
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
    connectSent = true;
    return;
  }

  // Step 2: After connect success, send skills.status
  if (msg.type === "res" && msg.ok && connectSent && !skillsStatusSent) {
    // This is the connect response (payload has: protocol, server, features, etc.)
    ws.send(JSON.stringify({ type: "req", method: "skills.status", id: randomUUID() }));
    skillsStatusSent = true;
    return;
  }

  // Step 3: Receive skills.status response
  if (msg.type === "res" && msg.ok && skillsStatusSent && msg.payload?.skills) {
    const skills = msg.payload.skills;
    const blocked = skills.filter((s) => s.guardBlocked).map((s) => s.name);
    console.log(JSON.stringify({ count: skills.length, blocked }));
    ws.close();
    process.exit(0);
  }

  // Handle errors
  if (msg.type === "res" && !msg.ok) {
    console.error("Response error:", JSON.stringify(msg).substring(0, 300));
    ws.close();
    process.exit(1);
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});
setTimeout(() => {
  console.error("Timeout (30s)");
  ws.close();
  process.exit(1);
}, 30000);
