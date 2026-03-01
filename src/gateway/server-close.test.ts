import { describe, expect, it, vi } from "vitest";
import { createGatewayCloseHandler } from "./server-close.js";

describe("gateway close handler", () => {
  it("aborts active chat runs and embedded runs during shutdown", async () => {
    const chatAbortController = new AbortController();
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller: chatAbortController,
          sessionId: "session-1",
          sessionKey: "main",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const abortAllEmbeddedRuns = vi.fn(() => 1);
    const broadcast = vi.fn();
    const tickInterval = setInterval(() => {}, 60_000);
    const healthInterval = setInterval(() => {}, 60_000);
    const dedupeCleanup = setInterval(() => {}, 60_000);

    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => {}),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: {
        stop: vi.fn(),
        updateConfig: vi.fn(),
      },
      updateCheckStop: null,
      nodePresenceTimers: new Map(),
      chatAbortControllers,
      abortAllEmbeddedRuns,
      broadcast,
      tickInterval,
      healthInterval,
      dedupeCleanup,
      agentUnsub: null,
      heartbeatUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => {}) },
      browserControl: null,
      wss: {
        close: (cb: () => void) => cb(),
      } as never,
      httpServer: {
        closeIdleConnections: vi.fn(),
        close: (cb: (err?: Error) => void) => cb(),
      } as never,
    });

    await close({ reason: "gateway restarting", restartExpectedMs: 1500 });

    expect(chatAbortController.signal.aborted).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
    expect(abortAllEmbeddedRuns).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("shutdown", {
      reason: "gateway restarting",
      restartExpectedMs: 1500,
    });
  });
});
