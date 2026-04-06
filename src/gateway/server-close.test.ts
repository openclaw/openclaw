import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayCloseHandler } from "./server-close.js";

type TestGatewayHookEvent = {
  type?: string;
  action?: string;
  context?: Record<string, unknown>;
};

const { triggerInternalHook, readRestartSentinel, writeRestartSentinel } = vi.hoisted(() => ({
  triggerInternalHook: vi.fn(
    async (_event: TestGatewayHookEvent, _opts?: { perHandlerTimeoutMs?: number }) => undefined,
  ),
  readRestartSentinel: vi.fn(async () => null),
  writeRestartSentinel: vi.fn(async () => "sentinel.json"),
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

vi.mock("../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/restart-sentinel.js")>(
    "../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    readRestartSentinel,
    writeRestartSentinel,
  };
});

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [],
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn(async () => undefined),
}));

function createCloseHarness(params?: {
  lifecycleUnsub?: () => void;
  broadcast?: (event: string, payload: unknown) => void;
  stallWssClose?: boolean;
}) {
  const tickInterval = setInterval(() => undefined, 60_000);
  const healthInterval = setInterval(() => undefined, 60_000);
  const dedupeCleanup = setInterval(() => undefined, 60_000);
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
    broadcast: params?.broadcast ?? vi.fn(),
    tickInterval,
    healthInterval,
    dedupeCleanup,
    mediaCleanup: null,
    agentUnsub: null,
    heartbeatUnsub: null,
    transcriptUnsub: null,
    lifecycleUnsub: params?.lifecycleUnsub ?? null,
    chatRunState: { clear: vi.fn() },
    clients: new Set(),
    configReloader: { stop: vi.fn(async () => undefined) },
    wss: {
      close: (cb: () => void) => {
        if (!params?.stallWssClose) {
          cb();
        }
      },
    } as never,
    httpServer: {
      close: (cb: (err?: Error | null) => void) => cb(null),
      closeIdleConnections: vi.fn(),
    } as never,
  });
  return {
    close,
    dispose() {
      clearInterval(tickInterval);
      clearInterval(healthInterval);
      clearInterval(dedupeCleanup);
    },
  };
}

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    triggerInternalHook.mockReset();
    triggerInternalHook.mockResolvedValue(undefined);
    readRestartSentinel.mockReset();
    readRestartSentinel.mockResolvedValue(null);
    writeRestartSentinel.mockReset();
    writeRestartSentinel.mockResolvedValue("sentinel.json");
  });

  it("unsubscribes lifecycle listeners during shutdown", async () => {
    const lifecycleUnsub = vi.fn();
    const harness = createCloseHarness({ lifecycleUnsub });
    try {
      await harness.close({ reason: "test shutdown", initiator: "SIGTERM" });
      expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });

  it("continues shutdown when websocket close callback stalls", async () => {
    vi.useFakeTimers();
    const harness = createCloseHarness({ stallWssClose: true });

    let settled = false;
    const closePromise = harness.close().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_100);
    await Promise.resolve();
    expect(settled).toBe(true);

    await closePromise;
    harness.dispose();
  });

  it("emits gateway shutdown + pre-restart hooks with lifecycle metadata", async () => {
    const harness = createCloseHarness();
    try {
      await harness.close({
        reason: "gateway restarting",
        restartExpectedMs: 123,
        initiator: "SIGUSR1",
        restartId: "restart-123",
        correlationId: "corr-123",
      });

      const hookCalls = triggerInternalHook.mock.calls as Array<
        [TestGatewayHookEvent, { perHandlerTimeoutMs?: number }?]
      >;
      const shutdownEvent = hookCalls.find(
        (call) => call[0]?.type === "gateway" && call[0]?.action === "shutdown",
      )?.[0];
      const preRestartEvent = hookCalls.find(
        (call) => call[0]?.type === "gateway" && call[0]?.action === "pre-restart",
      )?.[0];

      expect(shutdownEvent?.context).toMatchObject({
        reason: "gateway restarting",
        restartExpectedMs: 123,
        initiator: "SIGUSR1",
        restartId: "restart-123",
        correlationId: "corr-123",
      });
      expect(preRestartEvent?.context).toMatchObject({
        reason: "gateway restarting",
        restartExpectedMs: 123,
        initiator: "SIGUSR1",
        restartId: "restart-123",
        correlationId: "corr-123",
      });
      expect(Array.isArray(preRestartEvent?.context?.outbox)).toBe(true);
      expect(triggerInternalHook.mock.calls[0]?.[1]).toMatchObject({
        perHandlerTimeoutMs: 1500,
      });
    } finally {
      harness.dispose();
    }
  });

  it("persists hook outbox tasks into restart sentinel", async () => {
    triggerInternalHook.mockImplementation(
      async (event: TestGatewayHookEvent, _opts?: { perHandlerTimeoutMs?: number }) => {
        if (event.type === "gateway" && event.action === "pre-restart") {
          const outbox = event.context?.outbox as Array<Record<string, unknown>>;
          outbox.push({
            message: "Gateway is back after restart",
            sessionKey: "agent:main:main",
          });
        }
      },
    );

    const harness = createCloseHarness();
    try {
      await harness.close({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
        initiator: "SIGUSR1",
        restartId: "restart-abc",
      });

      expect(writeRestartSentinel).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "restart",
          status: "ok",
          restartId: "restart-abc",
          correlationId: "restart-abc",
          initiator: "SIGUSR1",
          suppressPrimaryNotice: true,
          outbox: [
            expect.objectContaining({
              message: "Gateway is back after restart",
              sessionKey: "agent:main:main",
              restartId: "restart-abc",
              correlationId: "restart-abc",
            }),
          ],
        }),
      );
    } finally {
      harness.dispose();
    }
  });
});
