import { createServer } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { GatewayClient } from "./client.js";

// Find a free localhost port for ad-hoc WS servers.
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe("GatewayClient", () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
      wss = null;
    }
  });

  test("closes on missing ticks", async () => {
    const port = await getFreePort();
    wss = new WebSocketServer({ port, host: "127.0.0.1" });

    wss.on("connection", (socket) => {
      socket.once("message", (data) => {
        const first = JSON.parse(rawDataToString(data)) as { id?: string };
        const id = first.id ?? "connect";
        // Respond with tiny tick interval to trigger watchdog quickly.
        const helloOk = {
          type: "hello-ok",
          protocol: 2,
          server: { version: "dev", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 1, health: 1 },
            uptimeMs: 1,
          },
          policy: {
            maxPayload: 512 * 1024,
            maxBufferedBytes: 1024 * 1024,
            tickIntervalMs: 5,
          },
        };
        socket.send(JSON.stringify({ type: "res", id, ok: true, payload: helloOk }));
      });
    });

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onClose: (code, reason) => resolve({ code, reason }),
      });
      client.start();
    });

    const res = await closed;
    expect(res.code).toBe(4000);
    expect(res.reason).toContain("tick timeout");
  }, 4000);
});
