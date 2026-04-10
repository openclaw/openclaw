import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  logWarn: vi.fn(),
};
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [],
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn(async () => undefined),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: mocks.logWarn,
  })),
}));

const { createGatewayCloseHandler } = await import("./server-close.js");

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.logWarn.mockClear();
  });

  it("unsubscribes lifecycle listeners during shutdown", async () => {
    const lifecycleUnsub = vi.fn();
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => undefined),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      updateCheckStop: null,
      stopTaskRegistryMaintenance,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      wss: { close: (cb: () => void) => cb() } as never,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
    });

    await close({ reason: "test shutdown" });

    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
  });

  it("stops the config reloader and closes listeners before plugin teardown continues", async () => {
    const events: string[] = [];
    const close = createGatewayCloseHandler({
      bonjourStop: async () => {
        events.push("bonjourStop");
      },
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => {
        events.push("stopChannel");
      }),
      pluginServices: {
        stop: vi.fn(async () => {
          events.push("pluginServices.stop");
        }),
      } as never,
      cron: { stop: vi.fn(() => events.push("cron.stop")) },
      heartbeatRunner: { stop: vi.fn(() => events.push("heartbeat.stop")) } as never,
      updateCheckStop: null,
      stopTaskRegistryMaintenance: null,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(() => events.push("broadcast.shutdown")),
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set([{ socket: { close: vi.fn(() => events.push("client.close")) } }]),
      configReloader: {
        stop: vi.fn(async () => {
          events.push("configReloader.stop");
        }),
      },
      wss: {
        clients: new Set(),
        close: (cb: () => void) => {
          events.push("wss.close");
          cb();
        },
      } as never,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => {
          events.push("http.close");
          cb(null);
        },
        closeIdleConnections: vi.fn(() => events.push("http.closeIdleConnections")),
      } as never,
    });

    await close({ reason: "test shutdown" });

    expect(events.indexOf("configReloader.stop")).toBeLessThan(events.indexOf("bonjourStop"));
    expect(events.indexOf("wss.close")).toBeLessThan(events.indexOf("bonjourStop"));
    expect(events.indexOf("http.close")).toBeLessThan(events.indexOf("bonjourStop"));
    expect(events.indexOf("configReloader.stop")).toBeLessThan(
      events.indexOf("pluginServices.stop"),
    );
  });

  it("terminates lingering websocket clients when websocket close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let closeCallback: (() => void) | null = null;
    const terminate = vi.fn(() => {
      closeCallback?.();
    });
    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => undefined),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      updateCheckStop: null,
      stopTaskRegistryMaintenance: null,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      wss: {
        clients: new Set([{ terminate }]),
        close: (cb: () => void) => {
          closeCallback = cb;
        },
      } as never,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
    });

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS);
    await closePromise;

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("continues shutdown when websocket close hangs without tracked clients", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => undefined),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      updateCheckStop: null,
      stopTaskRegistryMaintenance: null,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      wss: {
        clients: new Set(),
        close: () => undefined,
      } as never,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
    });

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS + WEBSOCKET_CLOSE_FORCE_CONTINUE_MS);
    await closePromise;

    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close still pending after 250ms force window"),
      ),
    ).toBe(true);
  });
});
