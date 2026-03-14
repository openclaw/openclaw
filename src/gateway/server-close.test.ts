import { describe, expect, it, vi } from "vitest";
import { createGatewayCloseHandler } from "./server-close.js";

describe("createGatewayCloseHandler", () => {
  it("stops quantd sidecar during gateway shutdown", async () => {
    const quantdClose = vi.fn(async () => {});
    const stop = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => {}),
      pluginServices: null,
      quantd: { close: quantdClose },
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as { stop: () => void },
      updateCheckStop: null,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => {}, 1000),
      healthInterval: setInterval(() => {}, 1000),
      dedupeCleanup: setInterval(() => {}, 1000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => {}) },
      browserControl: null,
      wss: { close: (cb: () => void) => cb() } as { close: (cb: () => void) => void },
      httpServer: { close: (cb: (err?: Error) => void) => cb() } as {
        close: (cb: (err?: Error) => void) => void;
      },
    });

    await stop();

    expect(quantdClose).toHaveBeenCalledTimes(1);
  });
});
