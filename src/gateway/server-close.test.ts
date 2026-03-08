import { describe, expect, it, vi } from "vitest";
import { createGatewayCloseHandler } from "./server-close.js";

function createHttpServerStub() {
  return {
    closeIdleConnections: vi.fn(),
    close: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
  };
}

describe("gateway close handler", () => {
  it("terminates active supervisor runs before closing sockets", async () => {
    const terminateAll = vi.fn(async () => {});
    const httpServer = createHttpServerStub();
    const tickInterval = setInterval(() => {}, 60_000);
    const healthInterval = setInterval(() => {}, 60_000);
    const dedupeCleanup = setInterval(() => {}, 60_000);
    const handler = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: async () => {},
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      updateCheckStop: null,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval,
      healthInterval,
      dedupeCleanup,
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => {}) },
      browserControl: null,
      processSupervisor: { terminateAll },
      wss: { close: (cb: () => void) => cb() } as never,
      httpServer: httpServer as never,
    });

    try {
      await handler({ reason: "test restart", restartExpectedMs: 1_500 });
    } finally {
      clearInterval(tickInterval);
      clearInterval(healthInterval);
      clearInterval(dedupeCleanup);
    }

    expect(terminateAll).toHaveBeenCalledWith({
      reason: "manual-cancel",
      timeoutMs: 5_000,
    });
    expect(httpServer.close).toHaveBeenCalledTimes(1);
  });
});
