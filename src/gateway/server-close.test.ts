import type { Server as HttpServer } from "node:http";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import type { CanvasHostHandler, CanvasHostServer } from "../canvas-host/server.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createGatewayCloseHandler, type ShutdownResult } from "./server-close.js";

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [{ id: "telegram" }, { id: "discord" }],
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn(async () => {}),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeParams(overrides: Partial<Parameters<typeof createGatewayCloseHandler>[0]> = {}) {
  const defaults: Parameters<typeof createGatewayCloseHandler>[0] = {
    bonjourStop: null,
    tailscaleCleanup: null,
    canvasHost: null,
    canvasHostServer: null,
    stopChannel: vi.fn(async () => {}),
    pluginServices: null,
    cron: { stop: vi.fn() },
    heartbeatRunner: { stop: vi.fn() } as unknown as HeartbeatRunner,
    updateCheckStop: vi.fn(),
    nodePresenceTimers: new Map(),
    broadcast: vi.fn(),
    tickInterval: setInterval(() => {}, 100_000),
    healthInterval: setInterval(() => {}, 100_000),
    dedupeCleanup: setInterval(() => {}, 100_000),
    mediaCleanup: null,
    agentUnsub: null,
    heartbeatUnsub: null,
    chatRunState: { clear: vi.fn() },
    clients: new Set(),
    configReloader: { stop: vi.fn(async () => {}) },
    browserControl: null,
    wss: { close: vi.fn((cb: () => void) => cb()) } as unknown as WebSocketServer,
    httpServer: {
      close: vi.fn((cb: (err?: Error) => void) => cb()),
      closeIdleConnections: vi.fn(),
    } as unknown as HttpServer,
    ...overrides,
  };
  return defaults;
}

describe("createGatewayCloseHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes a clean shutdown with no warnings", async () => {
    const p = makeParams();
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(p.cron.stop).toHaveBeenCalled();
    expect((p.heartbeatRunner as unknown as { stop: Mock }).stop).toHaveBeenCalled();
    expect(p.chatRunState.clear).toHaveBeenCalled();
  });

  it("broadcasts shutdown event with reason and restartExpectedMs", async () => {
    const p = makeParams();
    const close = createGatewayCloseHandler(p);
    await close({ reason: "upgrade", restartExpectedMs: 5000 });

    expect(p.broadcast).toHaveBeenCalledWith("shutdown", {
      reason: "upgrade",
      restartExpectedMs: 5000,
    });
  });

  it("defaults reason to 'gateway stopping' when unset", async () => {
    const p = makeParams();
    const close = createGatewayCloseHandler(p);
    await close();

    expect(p.broadcast).toHaveBeenCalledWith("shutdown", {
      reason: "gateway stopping",
      restartExpectedMs: null,
    });
  });

  it("records warning when bonjour stop fails", async () => {
    const p = makeParams({
      bonjourStop: vi.fn(async () => {
        throw new Error("mdns unavailable");
      }),
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("bonjour");
  });

  it("records warning when tailscale cleanup fails", async () => {
    const p = makeParams({
      tailscaleCleanup: vi.fn(async () => {
        throw new Error("tailscale not running");
      }),
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("tailscale");
  });

  it("records warning when canvas host close fails", async () => {
    const p = makeParams({
      canvasHost: {
        close: vi.fn(async () => {
          throw new Error("canvas error");
        }),
      } as unknown as CanvasHostHandler,
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("canvas-host");
  });

  it("records warning when canvas host server close fails", async () => {
    const p = makeParams({
      canvasHostServer: {
        close: vi.fn(async () => {
          throw new Error("server error");
        }),
      } as unknown as CanvasHostServer,
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("canvas-host-server");
  });

  it("records warning for each failing channel stop", async () => {
    const stopChannel = vi.fn(async (id: string) => {
      if (id === "telegram") throw new Error("telegram stuck");
    });
    const p = makeParams({ stopChannel });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("channel/telegram");
    expect(result.warnings).not.toContain("channel/discord");
    expect(stopChannel).toHaveBeenCalledTimes(2);
  });

  it("records warning when plugin services stop fails", async () => {
    const p = makeParams({
      pluginServices: {
        stop: vi.fn(async () => {
          throw new Error("plugin error");
        }),
      } as unknown as PluginServicesHandle,
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("plugin-services");
  });

  it("records warning when update check stop throws", async () => {
    const p = makeParams({
      updateCheckStop: vi.fn(() => {
        throw new Error("timer error");
      }),
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("update-check");
  });

  it("records warning when agent unsub throws", async () => {
    const p = makeParams({
      agentUnsub: vi.fn(() => {
        throw new Error("unsub error");
      }),
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("agent-unsub");
  });

  it("records warning when heartbeat unsub throws", async () => {
    const p = makeParams({
      heartbeatUnsub: vi.fn(() => {
        throw new Error("heartbeat unsub error");
      }),
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("heartbeat-unsub");
  });

  it("tracks WebSocket client close failures", async () => {
    const badClient = {
      socket: {
        close: vi.fn(() => {
          throw new Error("ws already closed");
        }),
      },
    };
    const goodClient = {
      socket: { close: vi.fn() },
    };
    const clients = new Set([badClient, goodClient]);
    const p = makeParams({ clients });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("ws-clients");
    expect(clients.size).toBe(0);
  });

  it("records warning when config reloader stop fails", async () => {
    const p = makeParams({
      configReloader: {
        stop: vi.fn(async () => {
          throw new Error("reload error");
        }),
      },
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("config-reloader");
  });

  it("records warning when browser control stop fails", async () => {
    const p = makeParams({
      browserControl: {
        stop: vi.fn(async () => {
          throw new Error("browser error");
        }),
      },
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("browser-control");
  });

  it("records warning when HTTP server close fails", async () => {
    const p = makeParams({
      httpServer: {
        close: vi.fn((cb: (err?: Error) => void) => cb(new Error("EADDRINUSE"))),
      } as unknown as HttpServer,
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("http-server");
  });

  it("handles multiple HTTP servers and labels them with index", async () => {
    const okServer = {
      close: vi.fn((cb: (err?: Error) => void) => cb()),
      closeIdleConnections: vi.fn(),
    } as unknown as HttpServer;
    const failServer = {
      close: vi.fn((cb: (err?: Error) => void) => cb(new Error("port busy"))),
    } as unknown as HttpServer;

    const p = makeParams({
      httpServers: [okServer, failServer],
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("http-server[1]");
    expect(result.warnings).not.toContain("http-server[0]");
  });

  it("clears node presence timers", async () => {
    const timers = new Map<string, ReturnType<typeof setInterval>>();
    timers.set(
      "node-a",
      setInterval(() => {}, 100_000),
    );
    timers.set(
      "node-b",
      setInterval(() => {}, 100_000),
    );
    const p = makeParams({ nodePresenceTimers: timers });
    const close = createGatewayCloseHandler(p);
    await close({ reason: "test" });

    expect(timers.size).toBe(0);
  });

  it("collects multiple warnings from different subsystems", async () => {
    const p = makeParams({
      bonjourStop: vi.fn(async () => {
        throw new Error("boom");
      }),
      canvasHost: {
        close: vi.fn(async () => {
          throw new Error("boom");
        }),
      } as unknown as CanvasHostHandler,
      agentUnsub: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const close = createGatewayCloseHandler(p);
    const result = await close({ reason: "test" });

    expect(result.warnings).toContain("bonjour");
    expect(result.warnings).toContain("canvas-host");
    expect(result.warnings).toContain("agent-unsub");
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("normalizes restartExpectedMs to null for non-finite values", async () => {
    const p = makeParams();
    const close = createGatewayCloseHandler(p);
    await close({ reason: "test", restartExpectedMs: Number.NaN });

    expect(p.broadcast).toHaveBeenCalledWith("shutdown", {
      reason: "test",
      restartExpectedMs: null,
    });
  });

  it("calls closeIdleConnections when available", async () => {
    const httpServer = {
      close: vi.fn((cb: (err?: Error) => void) => cb()),
      closeIdleConnections: vi.fn(),
    } as unknown as HttpServer;
    const p = makeParams({ httpServer });
    const close = createGatewayCloseHandler(p);
    await close({ reason: "test" });

    expect(
      (httpServer as unknown as { closeIdleConnections: Mock }).closeIdleConnections,
    ).toHaveBeenCalled();
  });
});
