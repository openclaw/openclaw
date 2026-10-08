/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
beforeEach(() => {
  const storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  stubWindowGlobals(storage);
  vi.stubGlobal("WebSocket", MockWebSocket);
  // The heartbeat contract does not require device signing.
  vi.stubGlobal("crypto", { randomUUID: () => "heartbeat-request" });
  wsInstances.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function startConnect(client: GatewayBrowserClient, tickIntervalMs = 1_000) {
  client.start();
  const ws = getLatestWebSocket();
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "heartbeat-challenge", ts: 1_800_000_000_000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string };
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
  it("reconnects a silently stalled socket using its advertised Gateway heartbeat", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(ws.lastClose).toBeNull();
      await vi.advanceTimersByTimeAsync(1);

      expect(ws.lastClose).toEqual({ code: 4000, reason: "tick timeout" });
    } finally {
      client.stop();
    }
  });

  it.each([Number.MAX_SAFE_INTEGER, 2 ** 32 + 1])(
    "clamps the advertised heartbeat %d before scheduling its browser timer",
    async (advertisedTickIntervalMs) => {
      useNodeFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });

      try {
        const ws = await startConnect(client, advertisedTickIntervalMs);
        await vi.advanceTimersByTimeAsync(0);

        expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_147_483_647);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(ws.lastClose).toBeNull();
      } finally {
        client.stop();
      }
    },
  );

  it("keeps a healthy heartbeat and explicitly unbounded request alive", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client);
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
    } finally {
      client.stop();
    }
  });
});
