import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

let server: Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    wss?.close(() => resolve());
    if (!wss) {
      resolve();
    }
  });
  wss = undefined;

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    if (!server) {
      resolve();
    }
  });
  server = undefined;
});

async function listen(handler: (ws: WebSocket) => void): Promise<string> {
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", handler);
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test websocket server did not get a TCP address");
  }
  return `ws://127.0.0.1:${address.port}`;
}

async function runSmoke(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["scripts/durable-runtime-live-smoke.mjs", ...args], {
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_PASSWORD: "",
      OPENCLAW_GATEWAY_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}

describe("durable-runtime-live-smoke", () => {
  it("authenticates with OPENCLAW_GATEWAY_TOKEN without printing the token", async () => {
    const token = "test-live-smoke-token";
    let connectAuth: unknown;
    const url = await listen((ws) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.method === "connect") {
          connectAuth = frame.params.auth;
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { connected: true },
            }),
          );
          return;
        }
        if (frame.method === "chat.send") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { accepted: true },
            }),
          );
        }
      });
    });

    const result = await runSmoke(
      [
        "--gateway",
        url,
        "--session-key",
        "agent:test",
        "--message",
        "durable live smoke",
        "--timeout-ms",
        "2000",
        "--wait-after-send-ms",
        "1",
      ],
      { OPENCLAW_GATEWAY_TOKEN: token },
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(connectAuth).toEqual({ token });
    expect(result.stdout).not.toContain(token);
    const evidence = JSON.parse(result.stdout);
    expect(evidence).toMatchObject({
      auth: { password: false, token: true },
      chatSend: { ok: true },
      connect: { ok: true },
      ok: true,
    });
  });

  it("rejects a missing explicit token value", async () => {
    const result = await runSmoke(["--token", "--session-key", "agent:test", "--message", "hello"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--token requires a value");
  });
});
