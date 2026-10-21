/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startConnect, useHandshakeHarness } from "./gateway-handshake.test-support.ts";
import { getLatestWebSocket } from "./gateway-socket.test-support.ts";
import type { GatewayBrowserClient } from "./gateway.ts";
const createClient = useHandshakeHarness();
let client: GatewayBrowserClient;
beforeEach(() => {
  client = createClient();
});
async function connect(tickIntervalMs = 1_000) {
  const { ws, connectFrame } = await startConnect(client, "heartbeat-challenge");
  ws.emitMessage({
    type: "res",
    id: connectFrame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      policy: { tickIntervalMs },
    },
  });
  return ws;
}

describe("GatewayBrowserClient heartbeat recovery", () => {
  it("preserves a live transport through delayed application heartbeats and still detects a stale tab", async () => {
    const ws = await connect();
    const request = client.request("wizard.next", {}, { timeoutMs: null });
    void request.catch(() => undefined);
    const requestFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string };

    await vi.advanceTimersByTimeAsync(1_999);
    expect(ws.lastClose).toBeNull();
    expect(client.needsWakeReconnect).toBe(false);
    await vi.advanceTimersByTimeAsync(501);

    expect(ws.lastClose).toBeNull();
    expect(client.needsWakeReconnect).toBe(true);
    ws.emitMessage({ type: "event", event: "tick", seq: 1, payload: {} });
    expect(client.needsWakeReconnect).toBe(false);
    ws.emitMessage({ type: "res", id: requestFrame.id, ok: true, payload: { done: true } });
    await expect(request).resolves.toEqual({ done: true });
  });

  it("keeps an in-flight upgrade through tab wake while the Gateway is stalled", async () => {
    client.start();
    const ws = getLatestWebSocket();
    // A stalled Gateway main thread has not answered the HTTP upgrade yet.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.needsWakeReconnect).toBe(false);

    ws.emitClose(1006, "");
    // Waiting out reconnect backoff is a valid wake reason.
    expect(client.needsWakeReconnect).toBe(true);
  });

  it.each([Number.MAX_SAFE_INTEGER, 2 ** 32 + 1])(
    "clamps the advertised heartbeat %d when deciding whether a tab is stale",
    async (advertisedTickIntervalMs) => {
      const ws = await connect(advertisedTickIntervalMs);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(4_294_967_293);
      expect(ws.lastClose).toBeNull();
      expect(client.needsWakeReconnect).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.needsWakeReconnect).toBe(true);
    },
  );

  it("keeps a healthy heartbeat and explicitly unbounded request alive", async () => {
    const ws = await connect();
    const request = client.request("wizard.next", {}, { timeoutMs: null });
    const requestFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string };

    for (let seq = 1; seq <= 4; seq += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      ws.emitMessage({ type: "event", event: "tick", seq, payload: {} });
    }

    expect(ws.lastClose).toBeNull();
    ws.emitMessage({ type: "res", id: requestFrame.id, ok: true, payload: { done: true } });
    await expect(request).resolves.toEqual({ done: true });
    client.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ws.lastClose).toEqual({ code: undefined, reason: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });
});
