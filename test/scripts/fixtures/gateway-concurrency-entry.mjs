import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

const scenario = path.basename(process.argv[1], ".mjs");
const attemptPath = path.join(path.dirname(process.argv[1]), "attempt.json");
const attempt = existsSync(attemptPath) ? JSON.parse(readFileSync(attemptPath, "utf8")) + 1 : 1;
writeFileSync(attemptPath, JSON.stringify(attempt));
const failure = scenario === "workload" && attempt === 1 ? "none" : scenario;
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
let agentStarted = false;
let loadProbeCount = 0;
let historyProbeCount = 0;
let warmupProbeFailed = false;
let finishTurn;

function writeSpan(name, durationMs) {
  appendFileSync(
    process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH,
    `${JSON.stringify({
      schemaVersion: "openclaw.diagnostics.v1",
      timestamp: new Date().toISOString(),
      type: "span.end",
      name,
      durationMs,
    })}\n`,
  );
}

function finishAfterProbes() {
  if (loadProbeCount < 2 || (failure === "history" && historyProbeCount === 0) || !finishTurn) {
    return;
  }
  const finish = finishTurn;
  finishTurn = undefined;
  finish();
}

const server = createServer((request, response) => {
  response.setHeader("content-type", request.url === "/" ? "text/html" : "application/json");
  response.end(
    request.url === "/"
      ? "<html>synthetic benchmark fixture</html>"
      : JSON.stringify({ eventLoop: { degraded: false, delayP99Ms: 1, delayMaxMs: 2 } }),
  );
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    const reply = (payload) =>
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    switch (frame.method) {
      case "connect":
      case "sessions.subscribe":
      case "sessions.create":
        reply({});
        break;
      case "status":
        reply({
          processMemory: {
            heapTotalBytes: 8_388_608,
            heapUsedBytes: 4_194_304,
            rssBytes: 16_777_216,
          },
        });
        break;
      case "agent":
        agentStarted = true;
        writeSpan("fixture.turn", 1);
        reply({ status: "accepted", runId: frame.params.idempotencyKey });
        break;
      case "agent.wait":
        finishTurn = () => {
          if (failure === "history") {
            writeSpan("plugins.metadata.scan", 7);
          }
          reply({
            runId: frame.params.runId,
            status: failure === "workload" || failure === "diagnostic" ? "error" : "ok",
            terminalReply: {
              disposition: "visible",
              text: "OpenClaw gateway concurrency benchmark streaming response.",
            },
            terminalReceipt: {
              runId: frame.params.runId,
              sessionId: "fixture-session",
              turnId: frame.params.runId,
              effective: { provider: "openai", model: "gpt-5.6-luna" },
              terminalDisposition: "visible",
              successfulToolNames: [],
              rerouted: false,
            },
          });
        };
        finishAfterProbes();
        break;
      case "chat.history":
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { message: "fixture history failure" },
          }),
        );
        historyProbeCount += 1;
        finishAfterProbes();
        break;
      case "sessions.list":
        if (failure === "diagnostic" && !warmupProbeFailed) {
          warmupProbeFailed = true;
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { message: "synthetic-private-probe at /private/fixture/probe-content" },
            }),
          );
          break;
        }
        reply({ sessions: [] });
        // A second round starts only after the first complete sample was recorded.
        if (agentStarted) {
          loadProbeCount += 1;
          finishAfterProbes();
        }
        break;
      default:
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { message: `unexpected fixture RPC: ${frame.method}` },
          }),
        );
    }
  });
});
process.on("SIGTERM", () => {
  for (const socket of sockets.clients) {
    socket.terminate();
  }
  sockets.close();
  server.close(() => process.exit(failure === "teardown" ? 23 : 0));
  server.closeAllConnections();
});
server.listen(port, "127.0.0.1", () => {
  console.log("startup trace: sidecars.ready 1ms total=1ms");
});
