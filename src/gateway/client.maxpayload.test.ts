import { describe, expect, test, vi } from "vitest";
import { GatewayClient } from "./client.js";

const wsMockState = vi.hoisted(() => ({
  last: null as { url: unknown; opts: unknown } | null,
}));

vi.mock("ws", () => ({
  WebSocket: class MockWebSocket {
    on = vi.fn();
    close = vi.fn();
    send = vi.fn();

    constructor(url: unknown, opts: unknown) {
      wsMockState.last = { url, opts };
    }
  },
}));

describe("GatewayClient", () => {
  test("uses a large maxPayload for node snapshots", () => {
    wsMockState.last = null;
    const client = new GatewayClient({ url: "ws://127.0.0.1:1" });
    client.start();

    expect(wsMockState.last?.url).toBe("ws://127.0.0.1:1");
    expect(wsMockState.last?.opts).toEqual(
      expect.objectContaining({ maxPayload: 25 * 1024 * 1024 }),
    );
  });
});
