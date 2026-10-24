// Gateway maintenance tests cover periodic cleanup for media, dedupe records,
// stale chat buffers, expired runs, health summaries, and timer disposal.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ManagedWorktreeGcResult } from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isGatewayWorkAdmissionClosed,
  onGatewaySuspendAdmissionChange,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  retireSessionControllerInput,
  trackSessionControllerSourceWork,
} from "../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { registerChatAbortController } from "./chat-abort.js";
import type { HealthSummary } from "./health/types.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS, TICK_INTERVAL_MS } from "./server-constants.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

const {
  cleanOldMediaMock,
  pruneOutboundMediaMock,
  prunePlaybackTranscodeCacheMock,
  cleanupManagedOutgoingMediaRecordsMock,
  startDevicePairSetupMaintenanceMock,
} = vi.hoisted(() => ({
  cleanOldMediaMock: vi.fn(async () => {}),
  pruneOutboundMediaMock: vi.fn(async () => {}),
  prunePlaybackTranscodeCacheMock: vi.fn(async () => {}),
  cleanupManagedOutgoingMediaRecordsMock: vi.fn(async () => {}),
  startDevicePairSetupMaintenanceMock: vi.fn(async () => 0),
}));

// mock-isolation: In-memory maintenance timers must not start the device expiry worker.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: startDevicePairSetupMaintenanceMock,
}));

vi.mock("../media/store.js", async () => {
  const actual = await vi.importActual<typeof import("../media/store.js")>("../media/store.js");
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
    pruneOutboundMedia: pruneOutboundMediaMock,
    prunePlaybackTranscodeCache: prunePlaybackTranscodeCacheMock,
  };
});

// mock-isolation: Timer fixtures control managed cleanup while retaining the real lazy owner path.
vi.mock("./managed-image-attachments.js", () => ({
  cleanupManagedOutgoingMediaRecords: cleanupManagedOutgoingMediaRecordsMock,
}));

const MEDIA_CLEANUP_TTL_MS = 24 * 60 * 60_000;
const fixtureSources: RpcSourceRef[] = [];

function createActiveRun(sessionKey: string, kind?: RpcSourceRef["adapter"]["kind"]): RpcSourceRef {
  const ref = createRpcSourceForTest({ kind }, { sessionKey, sessionId: "sess-1" });
  fixtureSources.push(ref);
  return ref;
}

function createMaintenanceTimerDeps() {
  return {
    ...createGatewayMaintenanceStateForTest(),
    logHealth: { info: vi.fn(), error: vi.fn() },
    runDeliveryQueueMediaGc: vi.fn(async () => undefined),
  };
}

type MaintenanceTimerDeps = ReturnType<typeof createMaintenanceTimerDeps>;

async function createThawScenario() {
  const clock = createGatewaySchedulerClock();
  let nowMs = 0;
  let cpuUsage = { user: 0, system: 0 };
  vi.spyOn(process, "cpuUsage").mockImplementation(() => cpuUsage);
  const state: { restartReason?: "active-work" | "channel-restart-incomplete" } = {};
  let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission>;
  const base = createMaintenanceTimerDeps();
  const deps = {
    ...base,
    scheduler: createTestGatewayScheduler(clock.clock),
    isNixMode: true,
    activeWorkInspectors: {
      getChatRuns: vi.fn(() => (state.restartReason === "active-work" ? 1 : 0)),
    },
    restartRunningChannels: vi.fn(
      async (_mode: "new-thaw" | "deferred-retry", _shouldContinue?: () => boolean) =>
        state.restartReason !== "channel-restart-incomplete",
    ),
    refreshGatewayHealthSnapshot: vi.fn<
      (opts?: { probe?: boolean; includeSensitive?: boolean }) => Promise<HealthSummary>
    >(base.refreshGatewayHealthSnapshot),
    refreshPresence: vi.fn(),
    resetEventLoopHealth: vi.fn(),
  };
  const timers = startGatewayMaintenanceTimers(deps);
  await clock.advanceBy(0);
  const elapse = (gapMs: number, cpuCoreRatio = 0) => {
    nowMs += gapMs;
    clock.setTime(nowMs);
    cpuUsage = {
      user: cpuUsage.user + gapMs * 1_000 * cpuCoreRatio * 0.6,
      system: cpuUsage.system + gapMs * 1_000 * cpuCoreRatio * 0.4,
    };
  };
  return {
    deps,
    state,
    elapse,
    setAdmissionClosed(closed: boolean) {
      if (closed) {
        suspension = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspension?.commit()).toBe(true);
      } else {
        suspension?.release();
        suspension = null;
      }
    },
    advance: async (gapMs: number, cpuCoreRatio = 0) => {
      elapse(gapMs, cpuCoreRatio);
      await clock.wake();
    },
    stop: async () => {
      suspension?.release();
      await stopMaintenanceTimers(timers);
    },
    expectRecoveryCount(count: number, restarts = count, resets = count) {
      expect(deps.restartRunningChannels).toHaveBeenCalledTimes(restarts);
      expect(
        deps.refreshGatewayHealthSnapshot.mock.calls.filter(([opts]) => opts?.probe),
      ).toHaveLength(count);
      expect(deps.refreshPresence).toHaveBeenCalledTimes(count);
      expect(deps.resetEventLoopHealth).toHaveBeenCalledTimes(resets);
    },
    restartLogs: (kind: string) =>
      deps.logHealth.info.mock.calls.filter(([message]) => message.includes(`restart ${kind}`)),
  };
}

function seedStableDedupeEntries(deps: MaintenanceTimerDeps, now: number): void {
  for (let index = 0; index < DEDUPE_MAX; index += 1) {
    deps.dedupe.set(`stable-${index}`, { ts: now - 1_000 + index, ok: true });
  }
}

async function createTimedMaintenanceScenario() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
  const deps = createMaintenanceTimerDeps();
  return { deps, now: Date.now() };
}

function pendingDedupe(runId: string, now: number, expiresAtMs: number) {
  return {
    ts: now - DEDUPE_TTL_MS - 1,
    ok: true,
    payload: { runId, sessionKey: "agent:main:main", status: "accepted", expiresAtMs },
  };
}

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
) {
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    for (const ref of fixtureSources.splice(0)) {
      retireSessionControllerInput(ref.input);
    }
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    cleanOldMediaMock.mockReset().mockResolvedValue(undefined);
    pruneOutboundMediaMock.mockReset().mockResolvedValue(undefined);
    prunePlaybackTranscodeCacheMock.mockReset().mockResolvedValue(undefined);
    startDevicePairSetupMaintenanceMock.mockReset().mockResolvedValue(0);
    cleanupManagedOutgoingMediaRecordsMock.mockReset().mockResolvedValue(undefined);
  });

  it("does not recover channels after a CPU-busy timing gap", async () => {
    const harness = await createThawScenario();
    try {
      await harness.advance(TICK_INTERVAL_MS);
      const gap = TICK_INTERVAL_MS + 45_000;
      await harness.advance(gap, 0.5);
      await harness.advance(TICK_INTERVAL_MS);
      harness.expectRecoveryCount(0);
      expect(harness.deps.logHealth.info).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`gap ${gap}ms, CPU ratio 0.50`),
      );
      await harness.advance(gap);
      harness.expectRecoveryCount(1);
    } finally {
      await harness.stop();
    }
  });

  it("excludes slow thaw recovery work from later timing samples", async () => {
    const harness = await createThawScenario();
    const health = await harness.deps.refreshGatewayHealthSnapshot();
    harness.deps.refreshGatewayHealthSnapshot
      .mockImplementationOnce(async () => {
        harness.elapse(45_000);
        return health;
      })
      .mockImplementationOnce(async () => {
        harness.elapse(45_000, 1);
        return health;
      });
    try {
      for (const [gap, count] of [
        [TICK_INTERVAL_MS + 45_000, 1],
        [TICK_INTERVAL_MS, 1],
        [TICK_INTERVAL_MS + 45_000, 2],
        [TICK_INTERVAL_MS + 45_000, 3],
      ] as const) {
        await harness.advance(gap);
        harness.expectRecoveryCount(count);
      }
    } finally {
      await harness.stop();
    }
  });

  it.each(["active-work", "channel-restart-incomplete"] as const)(
    "retries thaw recovery deferred by %s",
    async (reason) => {
      const harness = await createThawScenario();
      harness.state.restartReason = reason;
      try {
        await harness.advance(TICK_INTERVAL_MS + 45_000);
        harness.expectRecoveryCount(1, reason === "active-work" ? 0 : 1);
        await harness.advance(TICK_INTERVAL_MS);
        harness.expectRecoveryCount(1, reason === "active-work" ? 0 : 2);
        harness.state.restartReason = undefined;
        await harness.advance(TICK_INTERVAL_MS);
        harness.expectRecoveryCount(1, reason === "active-work" ? 1 : 3);
        expect(harness.deps.restartRunningChannels.mock.calls.map(([mode]) => mode)).toEqual(
          reason === "active-work"
            ? ["deferred-retry"]
            : ["new-thaw", "deferred-retry", "deferred-retry"],
        );
        expect(harness.restartLogs("deferred")).toEqual([
          [
            reason === "active-work"
              ? "host thaw channel restart deferred: gateway still has active work"
              : "host thaw channel restart deferred: one or more channel accounts remain pending",
          ],
        ]);
      } finally {
        await harness.stop();
      }
    },
  );

  it.each([false, true])(
    "expires thaw restart recovery while admission is closed: %s",
    async (closed) => {
      const harness = await createThawScenario();
      harness.setAdmissionClosed(closed);
      harness.state.restartReason = closed ? undefined : "active-work";
      try {
        await harness.advance(TICK_INTERVAL_MS + 45_000);
        for (
          let elapsedMs = TICK_INTERVAL_MS;
          elapsedMs < 10 * 60_000;
          elapsedMs += TICK_INTERVAL_MS
        ) {
          await harness.advance(TICK_INTERVAL_MS);
        }
        if (!closed) {
          expect(harness.deps.activeWorkInspectors.getChatRuns).toHaveBeenCalledTimes(20);
        }
        await harness.advance(TICK_INTERVAL_MS);
        harness.setAdmissionClosed(false);
        harness.state.restartReason = undefined;
        await harness.advance(TICK_INTERVAL_MS);
        expect(harness.deps.restartRunningChannels).not.toHaveBeenCalled();
        expect(harness.restartLogs("abandoned")).toHaveLength(1);
        if (closed) {
          harness.expectRecoveryCount(1, 0);
        } else {
          expect(harness.restartLogs("deferred")).toEqual([
            ["host thaw channel restart deferred: gateway still has active work"],
          ]);
          expect(harness.restartLogs("abandoned")).toEqual([
            [expect.stringContaining("gateway stayed busy")],
          ]);
          await harness.advance(TICK_INTERVAL_MS + 45_000);
          expect(harness.deps.restartRunningChannels).toHaveBeenCalledOnce();
        }
      } finally {
        await harness.stop();
      }
    },
  );

  it.each(["before", "during"])(
    "resumes thaw recovery when admission closes %s recovery",
    async (when) => {
      const harness = await createThawScenario();
      const midRecovery = when === "during";
      if (midRecovery) {
        harness.deps.resetEventLoopHealth.mockImplementationOnce(() =>
          harness.setAdmissionClosed(true),
        );
      } else {
        harness.setAdmissionClosed(true);
      }
      try {
        await harness.advance(TICK_INTERVAL_MS + 45_000);
        harness.expectRecoveryCount(0, 0, midRecovery ? 1 : 0);
        harness.setAdmissionClosed(false);
        await harness.advance(TICK_INTERVAL_MS);
        if (midRecovery) {
          expect(harness.deps.logHealth.info).toHaveBeenCalledWith(
            "host thaw recovery deferred: gateway suspension began mid-recovery",
          );
        } else {
          await harness.advance(TICK_INTERVAL_MS);
        }
        harness.expectRecoveryCount(1, 1, midRecovery ? 2 : 1);
      } finally {
        await harness.stop();
      }
    },
  );

  it("leaves admission untouched on busy thaw ticks and retries a failed idle pass", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 0, system: 0 });
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    resetGatewayWorkAdmission();
    let activeChatRuns = 1;
    let restartSucceeds = false;
    const restartRunningChannels = vi.fn(
      async (_mode: "new-thaw" | "deferred-retry", shouldContinue?: () => boolean) => {
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(shouldContinue?.()).toBe(true);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
        return restartSucceeds;
      },
    );
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      restartRunningChannels,
      activeWorkInspectors: {
        getChatRuns: () => activeChatRuns,
      },
    });

    const phases: string[] = [];
    const unsubscribe = onGatewaySuspendAdmissionChange((phase) => phases.push(phase));
    try {
      vi.setSystemTime(Date.now() + TICK_INTERVAL_MS + 45_000);
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
      expect(restartRunningChannels).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
      expect(phases).toEqual([]);

      activeChatRuns = 0;
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
      expect(restartRunningChannels).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);

      restartSucceeds = true;
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
      expect(restartRunningChannels).toHaveBeenCalledTimes(2);
      expect(restartRunningChannels.mock.calls.map(([mode]) => mode)).toEqual([
        "deferred-retry",
        "deferred-retry",
      ]);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);

      expect(phases).toEqual([
        "preparing",
        "prepared",
        "accepting",
        "preparing",
        "prepared",
        "accepting",
      ]);
    } finally {
      unsubscribe();
      await stopMaintenanceTimers(timers);
      resetGatewayWorkAdmission();
    }
  });

  it("leaves admission open when thaw active-work inspection fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 0, system: 0 });
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const restartRunningChannels = vi.fn(async () => true);
    const logHealth = { info: vi.fn(), error: vi.fn() };
    let inspectionFails = true;
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      logHealth,
      restartRunningChannels,
      activeWorkInspectors: {
        getChatRuns: () => {
          if (inspectionFails) {
            throw new Error("inspection failed");
          }
          return 0;
        },
      },
    });

    vi.setSystemTime(Date.now() + TICK_INTERVAL_MS + 45_000);
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);

    expect(restartRunningChannels).not.toHaveBeenCalled();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(logHealth.error).toHaveBeenCalledWith(
      "host thaw channel restart failed: Error: inspection failed",
    );

    inspectionFails = false;
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(restartRunningChannels).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it("does not run media cleanup before the lifecycle owner activates it", async () => {
    vi.useFakeTimers();
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      getRuntimeConfig: () => ({ attachments: { ttlHours: 24 } }),
    });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).not.toHaveBeenCalled();
    expect(cleanupManagedOutgoingMediaRecordsMock).not.toHaveBeenCalled();
    expect(cleanOldMediaMock).not.toHaveBeenCalled();

    await timers.stopMediaCleanup();
    timers.startMediaCleanup();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).not.toHaveBeenCalled();
    expect(cleanupManagedOutgoingMediaRecordsMock).not.toHaveBeenCalled();
    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    await stopMaintenanceTimers(timers);
  });

  it("cancels media cleanup while the startup grace is pending", async () => {
    vi.useFakeTimers();
    const deps = createMaintenanceTimerDeps();
    const timers = startGatewayMaintenanceTimers(deps);
    timers.startMediaCleanup();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(timers.stopMediaCleanup()).resolves.toBe("drained");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.runDeliveryQueueMediaGc).not.toHaveBeenCalled();
    expect(prunePlaybackTranscodeCacheMock).not.toHaveBeenCalled();
    expect(cleanupManagedOutgoingMediaRecordsMock).not.toHaveBeenCalled();
    expect(pruneOutboundMediaMock).not.toHaveBeenCalled();
    await stopMaintenanceTimers(timers);
  });

  it("delays worktree cleanup until the first hourly tick and joins slow sweeps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const deps = createMaintenanceTimerDeps();
    const sweep = createDeferred<ManagedWorktreeGcResult>();
    deps.worktreeGc.mockReturnValueOnce(sweep.promise);
    const timers = startGatewayMaintenanceTimers(deps);

    await Promise.resolve();
    expect(deps.worktreeGc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(deps.worktreeGc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(deps.worktreeGc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.worktreeGc).toHaveBeenCalledTimes(1);
    sweep.resolve(deps.worktreeGcResult);
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
    expect(deps.worktreeGc).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
    expect(deps.worktreeGc).toHaveBeenCalledTimes(2);
  });

  it("records partial managed worktree cleanup in health logs", async () => {
    vi.useFakeTimers();
    const deps = createMaintenanceTimerDeps();
    deps.worktreeGc.mockResolvedValue({
      ...deps.worktreeGcResult,
      outcome: "partial",
      issues: [
        {
          id: "retained",
          stage: "idle",
          outcome: "failed",
          reason: "cleanup-failed: repository unavailable",
        },
      ],
      issueCount: 1,
      eligibleCount: 1,
      failedCount: 1,
      limitsSatisfied: false,
    });
    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
    expect(deps.logHealth.error).toHaveBeenCalledWith(
      expect.stringContaining("retained: cleanup-failed"),
    );
    await stopMaintenanceTimers(timers);
  });

  it("delegates setup-outcome deadlines to the device owner", async () => {
    const timers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    expect(startDevicePairSetupMaintenanceMock).toHaveBeenCalledOnce();
    expect(startDevicePairSetupMaintenanceMock).toHaveBeenCalledWith({
      scheduler: expect.objectContaining({ signal: expect.any(AbortSignal) }),
      onError: expect.any(Function),
    });
    await stopMaintenanceTimers(timers);
  });

  it("updates attachment cleanup policy between sweeps without restarting maintenance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:01.234Z"));
    let config: OpenClawConfig = { attachments: { ttlHours: 24 } };

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      getRuntimeConfig: () => config,
    });
    timers.startMediaCleanup();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(prunePlaybackTranscodeCacheMock).not.toHaveBeenCalled();
    expect(cleanupManagedOutgoingMediaRecordsMock).not.toHaveBeenCalled();
    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
    expect(pruneOutboundMediaMock).not.toHaveBeenCalled();
    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalled();
    });
    config = { attachments: { ttlHours: 2 } };
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(2);
    expect(pruneOutboundMediaMock).not.toHaveBeenCalled();
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);
    expect(cleanOldMediaMock).toHaveBeenLastCalledWith(2 * 60 * 60_000, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    config = {};
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);
    expect(pruneOutboundMediaMock).toHaveBeenCalledOnce();
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(3);

    await stopMaintenanceTimers(timers);
  });

  it("runs managed outgoing cleanup when the general media sweep fails", async () => {
    vi.useFakeTimers();
    cleanOldMediaMock.mockRejectedValueOnce(new Error("synthetic media sweep failure"));
    const deps = createMaintenanceTimerDeps();

    const timers = startGatewayMaintenanceTimers({
      ...deps,
      getRuntimeConfig: () => ({ attachments: { ttlHours: 24 } }),
    });
    timers.startMediaCleanup();

    await vi.advanceTimersByTimeAsync(130_000);
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
      expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
      expect(deps.logHealth.error).toHaveBeenCalledWith(
        expect.stringContaining("synthetic media sweep failure"),
      );
    });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.waitFor(() => {
      expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(2);
      expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(2);
    });

    await stopMaintenanceTimers(timers);
  });

  it("warms health once and refreshes passively only while clients are connected", async () => {
    const clock = createGatewaySchedulerClock();
    const deps = createMaintenanceTimerDeps();
    deps.scheduler = createTestGatewayScheduler(clock.clock);
    deps.refreshGatewayHealthSnapshot = vi.fn(async () => ({ ok: true }) as HealthSummary);

    const timers = startGatewayMaintenanceTimers(deps);
    try {
      await clock.advanceBy(0);
      expect(deps.refreshGatewayHealthSnapshot).toHaveBeenCalledWith({ probe: false });

      await clock.advanceBy(60_000);
      expect(deps.refreshGatewayHealthSnapshot).toHaveBeenCalledTimes(1);

      deps.clients.add({
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "test", version: "test", platform: "test", mode: "test" },
        },
      });
      await clock.advanceBy(60_000);
      expect(deps.refreshGatewayHealthSnapshot).toHaveBeenCalledTimes(2);
      expect(deps.refreshGatewayHealthSnapshot).toHaveBeenLastCalledWith({ probe: false });

      deps.clients.clear();
      await clock.advanceBy(60_000);
      expect(deps.refreshGatewayHealthSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      await stopMaintenanceTimers(timers);
    }
  });

  it("keeps managed outgoing cleanup independent of a hung general media sweep", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      getRuntimeConfig: () => ({ attachments: { ttlHours: 24 } }),
    });
    timers.startMediaCleanup();

    await vi.advanceTimersByTimeAsync(130_000);
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    });
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(2);
    });

    resolveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(3);
    });

    resolveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await stopMaintenanceTimers(timers);
  });

  it("does not overlap default outbound cleanup and drains it on shutdown", async () => {
    vi.useFakeTimers();
    const cleanup = createDeferred();
    pruneOutboundMediaMock.mockReturnValue(cleanup.promise);
    const timers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    timers.startMediaCleanup();

    await vi.advanceTimersByTimeAsync(130_000);
    expect(pruneOutboundMediaMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(pruneOutboundMediaMock).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = timers.stopMediaCleanup().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    cleanup.resolve();
    await stopping;
    expect(stopped).toBe(true);

    await stopMaintenanceTimers(timers);
  });

  it("waits for active media cleanup before stopping its lifecycle", async () => {
    vi.useFakeTimers();
    const playback = createDeferred();
    const managed = createDeferred();
    const general = createDeferred();
    prunePlaybackTranscodeCacheMock.mockReturnValue(playback.promise);
    cleanupManagedOutgoingMediaRecordsMock.mockReturnValue(managed.promise);
    cleanOldMediaMock.mockReturnValue(general.promise);
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      getRuntimeConfig: () => ({ attachments: { ttlHours: 24 } }),
    });
    timers.startMediaCleanup();
    await vi.advanceTimersByTimeAsync(130_000);
    await vi.waitFor(() => {
      expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
      expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
    expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    let stopped = false;
    let stopResult: "drained" | "timed-out" | undefined;
    const stopping = timers.stopMediaCleanup().then((result) => {
      stopResult = result;
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    playback.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    managed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    general.resolve();
    await stopping;
    expect(stopResult).toBe("drained");

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
    expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);
    await stopMaintenanceTimers(timers);
  });

  it.each(["managed", "queue"] as const)(
    "retains the %s timeout fence across gateway generations",
    async (kind) => {
      vi.useFakeTimers();
      const cleanup =
        kind === "queue" ? vi.fn(async () => {}) : cleanupManagedOutgoingMediaRecordsMock;
      const createDeps = () => ({
        ...createMaintenanceTimerDeps(),
        ...(kind === "queue" ? { runDeliveryQueueMediaGc: cleanup } : {}),
      });
      const oldCleanup = createDeferred();
      cleanup.mockReturnValueOnce(oldCleanup.promise);
      const oldTimers = startGatewayMaintenanceTimers(createDeps());
      oldTimers.startMediaCleanup();
      await vi.advanceTimersByTimeAsync(130_000);
      await vi.waitFor(() => {
        expect(cleanup).toHaveBeenCalledTimes(1);
      });
      const oldStopping = oldTimers.stopMediaCleanup();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(oldStopping).resolves.toBe("timed-out");

      const restartedTimers = startGatewayMaintenanceTimers(createDeps());
      restartedTimers.startMediaCleanup();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanup).toHaveBeenCalledTimes(1);

      oldCleanup.resolve();
      await vi.advanceTimersByTimeAsync(130_000);
      await vi.waitFor(() => {
        expect(cleanup).toHaveBeenCalledTimes(2);
      });
      await expect(restartedTimers.stopMediaCleanup()).resolves.toBe("drained");
      const settledTimers = startGatewayMaintenanceTimers(createDeps());
      await expect(settledTimers.stopMediaCleanup()).resolves.toBe("drained");
      await stopMaintenanceTimers(oldTimers);
      await stopMaintenanceTimers(restartedTimers);
      await stopMaintenanceTimers(settledTimers);
    },
  );

  it("keeps pending accepted agent dedupe entries until their run expiry", async () => {
    const { deps, now } = await createTimedMaintenanceScenario();
    deps.dedupe.set("agent:pending-agent", pendingDedupe("pending-agent", now, now + 120_000));
    deps.dedupe.set(
      "agent:expired-pending-agent",
      pendingDedupe("expired-pending-agent", now, now - 1),
    );

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has("agent:pending-agent")).toBe(true);
    expect(deps.dedupe.has("agent:expired-pending-agent")).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it("keeps pending chat sends through ttl and overflow until their run expiry", async () => {
    const { deps, now } = await createTimedMaintenanceScenario();
    seedStableDedupeEntries(deps, now);
    deps.dedupe.set(
      pendingChatSendDedupeKey("pending-chat"),
      pendingDedupe("pending-chat", now, now + 120_000),
    );
    deps.dedupe.set(
      pendingChatSendDedupeKey("expired-chat"),
      pendingDedupe("expired-chat", now, now - 1),
    );
    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has(pendingChatSendDedupeKey("pending-chat"))).toBe(true);
    expect(deps.dedupe.has(pendingChatSendDedupeKey("expired-chat"))).toBe(false);
    expect(deps.dedupe.size).toBe(DEDUPE_MAX);

    await stopMaintenanceTimers(timers);
  });

  it("evicts pending accepted agent dedupe entries with invalid run expiry", async () => {
    const { deps, now } = await createTimedMaintenanceScenario();
    deps.dedupe.set(
      "agent:invalid-expiry-pending-agent",
      pendingDedupe("invalid-expiry-pending-agent", now, Number.POSITIVE_INFINITY),
    );

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has("agent:invalid-expiry-pending-agent")).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it.each(["active", "wedged", "fresh", "persisted"] as const)(
    "leaves %s source expiry to its controller owner",
    async (phase) => {
      const { deps } = await createTimedMaintenanceScenario();
      const runId = `run-${phase}`;
      const source = createActiveRun("main");
      if (phase === "wedged" || phase === "fresh") {
        source.adapter.projectSessionTerminalPending = true;
      }
      if (phase === "persisted") {
        source.adapter.projectSessionTerminalPersisted = true;
      }
      // A fresh abort reservation has no observation; wedged/persisted sources do.
      if (phase === "wedged" || phase === "persisted") {
        source.adapter.projectSessionTerminalObservedAt = Date.now() - 120_000;
      }
      rpcSourceTesting.set(runId, source);
      const timers = startGatewayMaintenanceTimers(deps);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(source.input.abortSignal.aborted).toBe(false);
      expect(rpcSourceTesting.get(runId)).toBe(source);
      await stopMaintenanceTimers(timers);
    },
  );

  it("leaves stalled terminal persistence and recovery ownership with the controller", async () => {
    const { deps } = await createTimedMaintenanceScenario();
    const runId = "run-terminal-persistence";
    const terminalRun = createActiveRun("main");
    terminalRun.input.retirementRequested = true;
    terminalRun.adapter.lifecycleGeneration = "generation-1";
    terminalRun.adapter.projectSessionTerminalObservedAt = Date.now() - 120_000;
    terminalRun.adapter.projectSessionTerminalPersistence = new Promise<void>(() => {});
    rpcSourceTesting.set(runId, terminalRun);
    const target = expectDefined(terminalRun.input.target, "Expected captured fixture target");
    const recoveryCandidate = {
      storePath: target.storeScope,
      agentId: target.agentId,
      runId,
      sourceRunId: "source-terminal-persistence",
      lifecycleGeneration: "generation-1",
      sessionKey: "main",
      sessionId: "sess-1",
      observedAt: terminalRun.adapter.projectSessionTerminalObservedAt,
    };
    deps.restartRecoveryCandidates.set(runId, recoveryCandidate);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(terminalRun.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.get(runId)).toBe(terminalRun);
    expect(deps.restartRecoveryCandidates.get(runId)).toBe(recoveryCandidate);
    await stopMaintenanceTimers(timers);
  });

  it("retains an expired terminal projection until raw source publication finishes", async () => {
    const { deps } = await createTimedMaintenanceScenario();
    const registration = registerChatAbortController({
      runId: "private-timeout",
      sessionId: "sess-1",
      sessionKey: "main",
      target: captureSessionTarget({
        storeScope: "/synthetic/maintenance-source",
        sessionKey: "main",
        incarnation: "sess-1",
      }),
      timeoutMs: 60_000,
    });
    const source = registration.entry;
    if (!source) {
      throw new Error("Expected registered maintenance source");
    }
    const publication = createDeferred();
    trackSessionControllerSourceWork(source.input, publication.promise);
    source.adapter.projectSessionTerminalObservedAt = Date.now() - 120_000;
    const timers = startGatewayMaintenanceTimers(deps);
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(rpcSourceTesting.get("private-timeout")).toBe(source);
      expect(source.input.abortSignal.aborted).toBe(false);
      publication.resolve();
      registration.cleanup();
      await source.input.settlement.promise;
      expect(rpcSourceTesting.has("private-timeout")).toBe(false);
    } finally {
      publication.resolve();
      await stopMaintenanceTimers(timers);
    }
  });
});
