import crypto from "node:crypto";
import net from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startControlChannel } from "./control-channel.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";

// Mock health/status to avoid hitting real services
vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn(async () => ({
    ts: Date.now(),
    durationMs: 10,
    web: {
      linked: true,
      authAgeMs: 1000,
      connect: { ok: true, status: 200, error: null, elapsedMs: 5 },
    },
    heartbeatSeconds: 60,
    sessions: { path: "/tmp/sessions.json", count: 1, recent: [] },
    ipc: { path: "/tmp/clawdis.sock", exists: true },
  })),
}));

vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn(async () => ({
    web: { linked: true, authAgeMs: 1000 },
    heartbeatSeconds: 60,
    sessions: {
      path: "/tmp/sessions.json",
      count: 1,
      defaults: { model: "claude-opus-4-5", contextTokens: 200_000 },
      recent: [],
    },
  })),
}));

describe("control channel", () => {
  let server: Awaited<ReturnType<typeof startControlChannel>>;
  let client: net.Socket;

  beforeAll(async () => {
    server = await startControlChannel({}, { port: 19999 });
    client = net.createConnection({ host: "127.0.0.1", port: 19999 });
  });

  afterAll(async () => {
    client.destroy();
    await server.close();
  });

  const sendRequest = (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = crypto.randomUUID();
      const frame = { type: "request", id, method, params };
      client.write(`${JSON.stringify(frame)}\n`);
      const onData = (chunk: Buffer) => {
        const lines = chunk.toString("utf8").trim().split(/\n/);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as { id?: string };
            if (parsed.id === id) {
              client.off("data", onData);
              resolve(parsed as Record<string, unknown>);
              return;
            }
          } catch {
            /* ignore non-JSON noise */
          }
        }
      };
      client.on("data", onData);
      client.on("error", reject);
    });

  it("responds to ping", async () => {
    const res = await sendRequest("ping");
    expect(res.ok).toBe(true);
  });

  it("returns health snapshot", async () => {
    const res = await sendRequest("health");
    expect(res.ok).toBe(true);
    const payload = res.payload as { web?: { linked?: boolean } };
    expect(payload.web?.linked).toBe(true);
  });

  it("emits heartbeat events", async () => {
    const evtPromise = new Promise<Record<string, unknown>>((resolve) => {
      const handler = (chunk: Buffer) => {
        const lines = chunk.toString("utf8").trim().split(/\n/);
        for (const line of lines) {
          const parsed = JSON.parse(line) as { type?: string; event?: string };
          if (parsed.type === "event" && parsed.event === "heartbeat") {
            client.off("data", handler);
            resolve(parsed as Record<string, unknown>);
          }
        }
      };
      client.on("data", handler);
    });

    emitHeartbeatEvent({ status: "sent", to: "+1", preview: "hi" });
    const evt = await evtPromise;
    expect(evt.event).toBe("heartbeat");
  });
});
