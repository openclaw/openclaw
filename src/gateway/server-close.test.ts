import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { createGatewayCloseHandler } from "./server-close.js";

const { triggerInternalHook } = vi.hoisted(() => ({
  triggerInternalHook: vi.fn(),
}));

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => []),
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn(async () => {}),
}));

function makeServer() {
  return {
    close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
  } as unknown as HttpServer;
}

function makeWss() {
  return {
    close: vi.fn((cb?: () => void) => cb?.()),
  } as unknown as WebSocketServer;
}

describe("createGatewayCloseHandler", () => {
  it("emits gateway shutdown + pre-restart hooks", async () => {
    triggerInternalHook.mockClear();

    const tickInterval = setInterval(() => {}, 10);
    const healthInterval = setInterval(() => {}, 10);
    const dedupeCleanup = setInterval(() => {}, 10);
    const handler = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => {}),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() },
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval,
      healthInterval,
      dedupeCleanup,
      agentUnsub: null,
      heartbeatUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => {}) },
      browserControl: null,
      wss: makeWss(),
      httpServer: makeServer(),
    });

    await handler({ reason: "gateway restarting", restartExpectedMs: 123 });
    clearInterval(tickInterval);
    clearInterval(healthInterval);
    clearInterval(dedupeCleanup);

    const shutdownEvent = triggerInternalHook.mock.calls.find(
      (call) => call[0]?.type === "gateway" && call[0]?.action === "shutdown",
    )?.[0];
    const preRestartEvent = triggerInternalHook.mock.calls.find(
      (call) => call[0]?.type === "gateway" && call[0]?.action === "pre-restart",
    )?.[0];

    expect(shutdownEvent?.context).toMatchObject({
      reason: "gateway restarting",
      restartExpectedMs: 123,
    });
    expect(preRestartEvent?.context).toMatchObject({
      reason: "gateway restarting",
      restartExpectedMs: 123,
    });
  });
});
