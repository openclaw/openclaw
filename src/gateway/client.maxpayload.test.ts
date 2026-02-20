import { describe, expect, test, vi } from "vitest";

describe("GatewayClient", () => {
  test("uses a large maxPayload for node snapshots", async () => {
    vi.resetModules();

    class MockWebSocket {
      static last: { url: unknown; opts: unknown } | null = null;

      on = vi.fn();
      close = vi.fn();
      send = vi.fn();

      constructor(url: unknown, opts: unknown) {
        MockWebSocket.last = { url, opts };
      }
    }

    vi.doMock("ws", () => ({
      WebSocket: MockWebSocket,
    }));

    const { GatewayClient } = await import("./client.js");
    const client = new GatewayClient({ url: "ws://127.0.0.1:1" });
    client.start();

    expect(MockWebSocket.last?.url).toBe("ws://127.0.0.1:1");
    expect(MockWebSocket.last?.opts).toEqual(
      expect.objectContaining({ maxPayload: 25 * 1024 * 1024 }),
    );
  });
});
