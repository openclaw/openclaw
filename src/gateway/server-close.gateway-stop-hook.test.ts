import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createGatewayCloseHandler } from "./server-close.js";

vi.mock("../plugins/hook-runner-global.js");
vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn().mockReturnValue([]),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

function makeParams() {
  const httpServer = {
    close: vi.fn((cb: (err?: Error) => void) => cb()),
    closeIdleConnections: vi.fn(),
  };
  return {
    bonjourStop: null,
    tailscaleCleanup: null,
    canvasHost: null,
    canvasHostServer: null,
    stopChannel: vi.fn().mockResolvedValue(undefined),
    pluginServices: null,
    cron: { stop: vi.fn() },
    heartbeatRunner: { stop: vi.fn() },
    nodePresenceTimers: new Map(),
    broadcast: vi.fn(),
    tickInterval: setInterval(() => {}, 999999),
    healthInterval: setInterval(() => {}, 999999),
    dedupeCleanup: setInterval(() => {}, 999999),
    agentUnsub: null,
    heartbeatUnsub: null,
    chatRunState: { clear: vi.fn() },
    clients: new Set(),
    configReloader: { stop: vi.fn().mockResolvedValue(undefined) },
    browserControl: null,
    wss: { close: vi.fn((cb: () => void) => cb()) },
    httpServer,
    httpServers: undefined,
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

describe("gateway_stop hook integration", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runGatewayStop: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    hookRunner = {
      hasHooks: vi.fn(),
      runGatewayStop: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  });

  it("fires gateway_stop hook with reason before shutdown", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runGatewayStop.mockResolvedValue(undefined);
    const close = createGatewayCloseHandler(makeParams());

    await close({ reason: "config reload" });

    expect(hookRunner.hasHooks).toHaveBeenCalledWith("gateway_stop");
    expect(hookRunner.runGatewayStop).toHaveBeenCalledWith({ reason: "config reload" }, {});
  });

  it("uses default reason when none is provided", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runGatewayStop.mockResolvedValue(undefined);
    const close = createGatewayCloseHandler(makeParams());

    await close();

    expect(hookRunner.runGatewayStop).toHaveBeenCalledWith({ reason: "gateway stopping" }, {});
  });

  it("does not invoke hook when no hooks are registered", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const close = createGatewayCloseHandler(makeParams());

    await close({ reason: "test" });

    expect(hookRunner.runGatewayStop).not.toHaveBeenCalled();
  });

  it("continues shutdown when hook throws", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runGatewayStop.mockRejectedValue(new Error("plugin crash"));
    const params = makeParams();
    const close = createGatewayCloseHandler(params);

    // Should not throw despite hook failure.
    await close({ reason: "graceful" });

    // Verify shutdown continued (cron stopped, clients cleared, etc.).
    expect(params.cron.stop).toHaveBeenCalled();
    expect(params.chatRunState.clear).toHaveBeenCalled();
  });

  it("does not invoke hook when hookRunner is null", async () => {
    mockGetGlobalHookRunner.mockReturnValue(null);
    const close = createGatewayCloseHandler(makeParams());

    // Should not throw.
    await close({ reason: "shutdown" });
  });
});
