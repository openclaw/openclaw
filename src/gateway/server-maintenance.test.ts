import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";

const cleanOldMediaMock = vi.fn(async () => {});

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/store.js")>();
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
  };
});

const MEDIA_CLEANUP_TTL_MS = 24 * 60 * 60_000;

function createMaintenanceTimerDeps() {
  return {
    broadcast: () => {},
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
    logHealth: { error: () => {} },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: { abortedRuns: new Map() },
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
  };
}

function stopMaintenanceTimers(timers: {
  tickInterval: NodeJS.Timeout;
  healthInterval: NodeJS.Timeout;
  dedupeCleanup: NodeJS.Timeout;
  mediaCleanup: NodeJS.Timeout | null;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  if (timers.mediaCleanup) {
    clearInterval(timers.mediaCleanup);
  }
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not schedule recursive media cleanup unless ttl is configured", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
    });

    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    expect(timers.mediaCleanup).toBeNull();

    stopMaintenanceTimers(timers);
  });

  it("runs startup media cleanup and repeats it hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    cleanOldMediaMock.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    stopMaintenanceTimers(timers);
  });

  it("skips overlapping media cleanup runs", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    let cleanupReady = false;
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
          cleanupReady = true;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    if (cleanupReady) {
      resolveCleanup();
    }
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);

    stopMaintenanceTimers(timers);
  });

  it("broadcasts runtime.formal and emits system events for opened/resolved runtime issues", async () => {
    const { applyFormalRuntimeMonitoringUpdate } = await import("./server-maintenance.js");
    const broadcast = vi.fn();
    const nodeSendToAllSubscribed = vi.fn();
    const enqueueRuntimeSystemEvent = vi.fn();

    const degraded = {
      status: "degraded",
      agents: {
        defaultAgentId: "gateway",
        total: 1,
        active: 0,
        quiet: 0,
        idle: 1,
        heartbeatEnabled: 1,
        heartbeatDisabled: 0,
        entries: [],
      },
      quantd: { status: "unreachable" },
      issues: [
        {
          code: "quantd.unreachable",
          priority: "P0",
          summary: "quantd currently unreachable",
        },
      ],
      issueCounts: { P0: 1, P1: 0, P2: 0, INFO: 0 },
    } as NonNullable<HealthSummary["monitoring"]>;
    const healthy = {
      ...degraded,
      status: "ok",
      quantd: { status: "ok" },
      issues: [],
      issueCounts: { P0: 0, P1: 0, P2: 0, INFO: 0 },
    } as NonNullable<HealthSummary["monitoring"]>;

    const first = applyFormalRuntimeMonitoringUpdate({
      previous: undefined,
      monitoring: degraded,
      broadcast,
      nodeSendToAllSubscribed,
      enqueueRuntimeSystemEvent,
      getPresenceVersion: () => 2,
      getHealthVersion: () => 3,
    });
    expect(first).toBe(degraded);
    expect(broadcast).toHaveBeenCalledWith(
      "runtime.formal",
      degraded,
      expect.objectContaining({
        stateVersion: { presence: 2, health: 3 },
      }),
    );
    expect(nodeSendToAllSubscribed).toHaveBeenCalledWith("runtime.formal", degraded);
    expect(enqueueRuntimeSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("quantd.unreachable"),
    );

    broadcast.mockClear();
    nodeSendToAllSubscribed.mockClear();
    enqueueRuntimeSystemEvent.mockClear();

    const second = applyFormalRuntimeMonitoringUpdate({
      previous: first,
      monitoring: healthy,
      broadcast,
      nodeSendToAllSubscribed,
      enqueueRuntimeSystemEvent,
      getPresenceVersion: () => 2,
      getHealthVersion: () => 4,
    });
    expect(second).toBe(healthy);
    expect(enqueueRuntimeSystemEvent).toHaveBeenCalledWith(expect.stringContaining("resolved"));
  });
});
