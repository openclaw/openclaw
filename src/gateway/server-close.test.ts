import type { Server } from "node:http";
import type { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";

const { getGlobalHookRunnerMock } = vi.hoisted(() => ({
  getGlobalHookRunnerMock: vi.fn(),
}));

const { triggerInternalHookMock, createInternalHookEventMock } = vi.hoisted(() => ({
  triggerInternalHookMock: vi.fn(),
  createInternalHookEventMock: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  triggerInternalHook: triggerInternalHookMock,
  createInternalHookEvent: createInternalHookEventMock,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn().mockReturnValue([]),
}));

import { createGatewayCloseHandler } from "./server-close.js";

function createMockParams(
  overrides: Partial<Parameters<typeof createGatewayCloseHandler>[0]> = {},
) {
  const interval = setInterval(() => {}, 1_000_000);
  return {
    bonjourStop: null,
    tailscaleCleanup: null,
    canvasHost: null,
    canvasHostServer: null,
    stopChannel: vi.fn().mockResolvedValue(undefined),
    pluginServices: null,
    cron: { stop: vi.fn() },
    heartbeatRunner: { stop: vi.fn() } as unknown as HeartbeatRunner,
    nodePresenceTimers: new Map<string, ReturnType<typeof setInterval>>(),
    broadcast: vi.fn(),
    tickInterval: interval,
    healthInterval: interval,
    dedupeCleanup: interval,
    agentUnsub: null,
    heartbeatUnsub: null,
    chatRunState: { clear: vi.fn() },
    clients: new Set<{ socket: { close: (code: number, reason: string) => void } }>(),
    configReloader: { stop: vi.fn().mockResolvedValue(undefined) },
    browserControl: null,
    wss: { close: (cb: () => void) => cb() } as unknown as WebSocketServer,
    httpServer: { close: (cb: (err?: Error) => void) => cb() } as unknown as Server,
    port: 18789,
    getConfig: () => ({ hooks: { internal: { enabled: true } } }),
    defaultWorkspaceDir: "/tmp/test-workspace",
    deps: {} as unknown as CliDeps,
    logHooks: { warn: vi.fn() },
    ...overrides,
  };
}

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getGlobalHookRunnerMock.mockReset();
    triggerInternalHookMock.mockReset();
    createInternalHookEventMock.mockReset();
    createInternalHookEventMock.mockImplementation(
      (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
        type,
        action,
        sessionKey,
        context,
        timestamp: new Date(),
        messages: [],
      }),
    );
    triggerInternalHookMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires gateway_stop plugin hook with reason and port", async () => {
    const runGatewayStop = vi.fn().mockResolvedValue(undefined);
    getGlobalHookRunnerMock.mockReturnValue({ runGatewayStop });

    const close = createGatewayCloseHandler(createMockParams());
    await close({ reason: "gateway stopping" });

    expect(runGatewayStop).toHaveBeenCalledWith({ reason: "gateway stopping" }, { port: 18789 });
  });

  it("fires gateway:shutdown internal hook with correct event", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    const params = createMockParams();
    const close = createGatewayCloseHandler(params);
    await close({ reason: "gateway stopping" });

    const expectedCfg = params.getConfig();
    expect(createInternalHookEventMock).toHaveBeenCalledWith(
      "gateway",
      "shutdown",
      "gateway:shutdown",
      expect.objectContaining({
        cfg: expectedCfg,
        deps: params.deps,
        workspaceDir: "/tmp/test-workspace",
        reason: "gateway stopping",
      }),
    );
    expect(triggerInternalHookMock).toHaveBeenCalled();
  });

  it("does not fire internal hook when cfg.hooks.internal.enabled is false", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    const close = createGatewayCloseHandler(
      createMockParams({ getConfig: () => ({ hooks: { internal: { enabled: false } } }) }),
    );
    await close();

    expect(triggerInternalHookMock).not.toHaveBeenCalled();
  });

  it("completes shutdown when hook runner is null", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    const params = createMockParams({
      getConfig: () => ({ hooks: { internal: { enabled: false } } }),
    });
    const close = createGatewayCloseHandler(params);
    await close();

    expect(params.cron.stop).toHaveBeenCalled();
  });

  it("passes restart reason through to hook events", async () => {
    const runGatewayStop = vi.fn().mockResolvedValue(undefined);
    getGlobalHookRunnerMock.mockReturnValue({ runGatewayStop });

    const close = createGatewayCloseHandler(createMockParams());
    await close({ reason: "gateway restarting" });

    expect(runGatewayStop).toHaveBeenCalledWith({ reason: "gateway restarting" }, { port: 18789 });
    expect(createInternalHookEventMock).toHaveBeenCalledWith(
      "gateway",
      "shutdown",
      "gateway:shutdown",
      expect.objectContaining({ reason: "gateway restarting" }),
    );
  });

  it("uses default reason when none provided", async () => {
    const runGatewayStop = vi.fn().mockResolvedValue(undefined);
    getGlobalHookRunnerMock.mockReturnValue({ runGatewayStop });

    const close = createGatewayCloseHandler(createMockParams());
    await close();

    expect(runGatewayStop).toHaveBeenCalledWith({ reason: "gateway stopping" }, { port: 18789 });
    expect(createInternalHookEventMock).toHaveBeenCalledWith(
      "gateway",
      "shutdown",
      "gateway:shutdown",
      expect.objectContaining({ reason: "gateway stopping" }),
    );
  });
});
