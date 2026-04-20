import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  totalPendingReplies: 0,
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  disposeAgentHarnesses: vi.fn(async () => undefined),
  disposeAllSessionMcpRuntimes: vi.fn(async () => undefined),
};
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;

vi.mock("../channels/plugins/index.js", async () => ({
  ...(await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  )),
  listChannelPlugins: () => [],
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn(async () => undefined),
}));

vi.mock("../auto-reply/reply/dispatcher-registry.js", () => ({
  getTotalPendingReplies: () => mocks.totalPendingReplies,
}));

vi.mock("../agents/harness/registry.js", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeAgentHarnesses,
}));

vi.mock("../agents/pi-bundle-mcp-tools.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/pi-bundle-mcp-tools.js")>(
    "../agents/pi-bundle-mcp-tools.js",
  )),
  disposeAllSessionMcpRuntimes: mocks.disposeAllSessionMcpRuntimes,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
  })),
}));

const { createGatewayCloseHandler } = await import("./server-close.js");
type GatewayCloseHandlerParams = Parameters<typeof createGatewayCloseHandler>[0];
type GatewayCloseClient = GatewayCloseHandlerParams["clients"] extends Set<infer T> ? T : never;

function createGatewayCloseTestDeps(
  overrides: Partial<GatewayCloseHandlerParams> = {},
): GatewayCloseHandlerParams {
  return {
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
    chatRunState: { clear: vi.fn(), abortedRuns: new Map() },
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    nodeSendToSession: vi.fn(),
    chatAbortControllers: new Map(),
    clients: new Set<GatewayCloseClient>(),
    configReloader: { stop: vi.fn(async () => undefined) },
    wss: {
      clients: new Set(),
      close: (cb: () => void) => cb(),
    } as never,
    httpServer: {
      close: (cb: (err?: Error | null) => void) => cb(null),
      closeIdleConnections: vi.fn(),
    } as never,
    ...overrides,
  };
}

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.totalPendingReplies = 0;
    mocks.logInfo.mockClear();
    mocks.logWarn.mockClear();
    mocks.disposeAgentHarnesses.mockClear();
    mocks.disposeAllSessionMcpRuntimes.mockClear();
    mocks.disposeAllSessionMcpRuntimes.mockResolvedValue(undefined);
  });

  it("unsubscribes lifecycle listeners during shutdown", async () => {
    const lifecycleUnsub = vi.fn();
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        stopTaskRegistryMaintenance,
        lifecycleUnsub,
      }),
    );

    await close({ reason: "test shutdown" });

    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.disposeAgentHarnesses).toHaveBeenCalledTimes(1);
    expect(mocks.disposeAllSessionMcpRuntimes).toHaveBeenCalledTimes(1);
  });

  it("continues shutdown when bundle MCP runtime disposal hangs", async () => {
    vi.useFakeTimers();
    mocks.disposeAllSessionMcpRuntimes.mockReturnValue(new Promise(() => undefined));
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(5_000);
    await closePromise;

    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("bundle-mcp runtime disposal exceeded 5000ms"),
      ),
    ).toBe(true);
  });

  it("waits for pending replies to settle before shutdown when a drain budget is provided", async () => {
    vi.useFakeTimers();
    mocks.totalPendingReplies = 1;

    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());
    const closePromise = close({ reason: "test shutdown", drainTimeoutMs: 200 });

    await vi.advanceTimersByTimeAsync(100);
    mocks.totalPendingReplies = 0;
    await vi.advanceTimersByTimeAsync(100);
    await closePromise;

    expect(
      mocks.logInfo.mock.calls.some(([message]) =>
        String(message).includes("waiting for 1 reply(ies) to settle before shutdown"),
      ),
    ).toBe(true);
    expect(
      mocks.logInfo.mock.calls.some(([message]) =>
        String(message).includes("pending replies settled after"),
      ),
    ).toBe(true);
  });

  it("aborts active chat runs when reply drain times out during shutdown", async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller,
          sessionId: "run-1",
          sessionKey: "session-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        broadcast,
        nodeSendToSession,
        chatRunBuffers: new Map([["run-1", "partial reply"]]),
        chatAbortControllers,
      }),
    );

    const closePromise = close({ reason: "test shutdown", drainTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await closePromise;

    expect(controller.signal.aborted).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("reply drain timeout after 100ms with 1 chat run(s) still active"),
      ),
    ).toBe(true);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("aborted 1 active chat run(s) during shutdown"),
      ),
    ).toBe(true);
    expect(
      mocks.logInfo.mock.calls.some(([message]) =>
        String(message).includes("pending replies settled after shutdown abort cleanup"),
      ),
    ).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted", stopReason: "shutdown" }),
    );
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "session-1",
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted", stopReason: "shutdown" }),
    );
  });

  it("does not abort active chat runs on shutdown when no reply drain budget is provided", async () => {
    const controller = new AbortController();
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller,
          sessionId: "run-1",
          sessionKey: "session-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatRunBuffers: new Map([["run-1", "partial reply"]]),
        chatAbortControllers,
      }),
    );

    await close({ reason: "test shutdown" });

    expect(controller.signal.aborted).toBe(false);
    expect(chatAbortControllers.size).toBe(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) => String(message).includes("reply drain timeout")),
    ).toBe(false);
  });

  it("aborts active chat runs immediately when the drain budget is already exhausted", async () => {
    const controller = new AbortController();
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller,
          sessionId: "run-1",
          sessionKey: "session-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        broadcast,
        nodeSendToSession,
        chatRunBuffers: new Map([["run-1", "partial reply"]]),
        chatAbortControllers,
      }),
    );

    await close({ reason: "test shutdown", drainTimeoutMs: 0 });

    expect(controller.signal.aborted).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("reply drain timeout after 0ms with 1 chat run(s) still active"),
      ),
    ).toBe(true);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("aborted 1 active chat run(s) during shutdown"),
      ),
    ).toBe(true);
    expect(
      mocks.logInfo.mock.calls.some(([message]) =>
        String(message).includes("pending replies settled after shutdown abort cleanup"),
      ),
    ).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted", stopReason: "shutdown" }),
    );
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "session-1",
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted", stopReason: "shutdown" }),
    );
  });

  it("terminates lingering websocket clients when websocket close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let closeCallback: (() => void) | null = null;
    const terminate = vi.fn(() => {
      closeCallback?.();
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        wss: {
          clients: new Set([{ terminate }]),
          close: (cb: () => void) => {
            closeCallback = cb;
          },
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS);
    await closePromise;

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("continues shutdown when websocket close hangs without tracked clients", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        wss: {
          clients: new Set(),
          close: () => undefined,
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS + WEBSOCKET_CLOSE_FORCE_CONTINUE_MS);
    await closePromise;

    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close still pending after 250ms force window"),
      ),
    ).toBe(true);
  });

  it("forces lingering HTTP connections closed when server close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let closeCallback: ((err?: Error | null) => void) | null = null;
    const closeAllConnections = vi.fn(() => {
      closeCallback?.(null);
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: (cb: (err?: Error | null) => void) => {
            closeCallback = cb;
          },
          closeAllConnections,
          closeIdleConnections: vi.fn(),
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS);
    await closePromise;

    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("http server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("fails shutdown when http server close still hangs after force close", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: () => undefined,
          closeAllConnections: vi.fn(),
          closeIdleConnections: vi.fn(),
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    const closeExpectation = expect(closePromise).rejects.toThrow(
      "http server close still pending after forced connection shutdown (5000ms)",
    );
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS + HTTP_CLOSE_FORCE_WAIT_MS);
    await closeExpectation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unbound http servers during shutdown", async () => {
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
      chatRunState: { clear: vi.fn(), abortedRuns: new Map() },
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      removeChatRun: vi.fn(),
      agentRunSeq: new Map(),
      nodeSendToSession: vi.fn(),
      chatAbortControllers: new Map(),
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      wss: { clients: new Set(), close: (cb: () => void) => cb() } as never,
      httpServer: {
        close: (cb: (err?: NodeJS.ErrnoException | null) => void) =>
          cb(
            Object.assign(new Error("Server is not running."), { code: "ERR_SERVER_NOT_RUNNING" }),
          ),
        closeIdleConnections: vi.fn(),
      } as never,
    });

    await expect(close({ reason: "startup failed before bind" })).resolves.toBeUndefined();
  });
});
