import "./server-worker-free.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const {
  checkTelemetryUpdateMock,
  generateSecureIntMock,
  devicePairCleanupMock,
  forbiddenDefaultAdapter,
} = vi.hoisted(() => ({
  checkTelemetryUpdateMock: vi.fn<typeof import("../infra/telemetry.js").checkTelemetryUpdate>(),
  generateSecureIntMock: vi.fn<typeof import("../infra/secure-random.js").generateSecureInt>(),
  devicePairCleanupMock: vi.fn(async () => 0),
  forbiddenDefaultAdapter: vi.fn((adapter: string): never => {
    throw new Error(`Unexpected default maintenance adapter: ${adapter}`);
  }),
}));

vi.mock("../infra/secure-random.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/secure-random.js")>()),
  generateSecureInt: generateSecureIntMock,
}));

vi.mock("../infra/device-bootstrap.js", () => ({
  pruneExpiredDevicePairSetupCompletions: devicePairCleanupMock,
}));

vi.mock("../infra/telemetry.js", () => ({
  checkTelemetryUpdate: checkTelemetryUpdateMock,
}));

// These default readers are unused by the supplied callbacks and empty task fixture.
vi.mock("../agents/worktrees/owner-protection.js", () => ({
  createManagedWorktreeOwnerPolicy: () => forbiddenDefaultAdapter("worktree owner policy"),
}));

vi.mock("../agents/worktrees/service.js", () => ({
  WORKTREE_GC_INTERVAL_MS: 60 * 60_000,
  managedWorktrees: { gc: () => forbiddenDefaultAdapter("worktree GC") },
  resolveWorktreeCleanupLimits: () => forbiddenDefaultAdapter("worktree cleanup limits"),
}));

vi.mock("../infra/delivery-queue-sqlite.js", () => ({
  captureDeliveryQueueStateContext: () => forbiddenDefaultAdapter("delivery queue context"),
  pruneExpiredDeliveryQueueTombstones: () => forbiddenDefaultAdapter("delivery queue GC"),
}));

vi.mock("../infra/outbound/delivery-queue-media-spool.js", () => ({
  pruneOrphanedDeliveryQueueMedia: () => forbiddenDefaultAdapter("delivery media GC"),
}));

vi.mock("../media/store.js", () => ({
  cleanOldMedia: () => forbiddenDefaultAdapter("media GC"),
  pruneOutboundMedia: () => forbiddenDefaultAdapter("outbound media GC"),
  prunePlaybackTranscodeCache: () => forbiddenDefaultAdapter("playback media GC"),
}));

vi.mock("../skills/workshop/store-sqlite-record.js", () => ({
  parseSkillProposalRow: () => forbiddenDefaultAdapter("skill proposal reader"),
}));

vi.mock("../skills/workshop/workspace-skill-read.js", () => ({
  listWritableWorkshopSkillSummaries: () => forbiddenDefaultAdapter("skill status reader"),
}));

vi.mock("./chat-abort.js", () => ({
  abortChatRunById: () => forbiddenDefaultAdapter("chat abort"),
  removeChatAbortControllerEntry: () => forbiddenDefaultAdapter("chat abort removal"),
}));

vi.mock("./session-request-agent.js", () => ({
  tryResolveSessionCompatibilityOwnerAgentId: () => forbiddenDefaultAdapter("media session owner"),
}));

vi.mock("./server-methods/session-active-runs.js", () => ({
  hasRegisteredChatRunForSessionKey: () => forbiddenDefaultAdapter("media session activity"),
}));

vi.mock("./server/health-state.js", () => ({
  setBroadcastHealthUpdate: vi.fn(),
}));

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  getInspectableActiveTaskRestartBlockers: () => [],
}));

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
): Promise<void> {
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
}

describe("gateway telemetry maintenance", () => {
  afterEach(() => {
    const defaultAdapterCalls = forbiddenDefaultAdapter.mock.calls;
    forbiddenDefaultAdapter.mockClear();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
    checkTelemetryUpdateMock.mockReset();
    generateSecureIntMock.mockReset();
    devicePairCleanupMock.mockReset().mockResolvedValue(0);
    expect(defaultAdapterCalls).toHaveLength(0);
  });

  it.each([
    ["health", "initial"],
    ["health", "interval"],
    ["worktree", "initial"],
    ["worktree", "interval"],
    ["device-pair", "initial"],
    ["device-pair", "interval"],
  ] as const)("joins admitted %s %s work and its cleanup before stopping", async (owner, phase) => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(0);
    checkTelemetryUpdateMock.mockResolvedValue(null);
    const operation = createDeferredCore();
    const cleanup = createDeferredCore();
    const cleanupStarted = createDeferredCore();
    let calls = 0;
    let cleanupWork: Promise<void> | undefined;
    const run = async () => {
      calls += 1;
      if (calls !== (phase === "initial" ? 1 : 2)) {
        return;
      }
      await operation.promise;
      cleanupWork = trackAsyncWork(() => cleanup.promise);
      cleanupStarted.resolve();
    };
    const state = createGatewayMaintenanceStateForTest();
    devicePairCleanupMock.mockImplementation(async () => {
      if (owner === "device-pair") {
        await run();
      }
      return 0;
    });
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...state,
      refreshGatewayHealthSnapshot: async () => {
        if (owner === "health") {
          await run();
        }
        return await state.refreshGatewayHealthSnapshot();
      },
      runWorktreeGc: async () => {
        if (owner === "worktree") {
          await run();
        }
      },
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });
    try {
      await vi.advanceTimersByTimeAsync(
        phase === "initial" ? 0 : owner === "worktree" ? 60 * 60_000 : 60_000,
      );
      expect(calls).toBe(phase === "initial" ? 1 : 2);
      markGatewayRestartDraining();
      let stopped = false;
      const stopping = timers.stopPeriodicTasks().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);

      operation.resolve();
      await cleanupStarted.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);

      cleanup.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      operation.resolve();
      cleanup.resolve();
      await cleanupStarted.promise;
      await cleanupWork;
      await stopMaintenanceTimers(timers);
    }
  });

  it.each(["restart", "local"] as const)(
    "retires periodic producers at %s drain before their owners close",
    async (drain) => {
      vi.useFakeTimers();
      vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 0, system: 0 });
      generateSecureIntMock.mockReturnValue(0);
      const check = createDeferredCore<null>();
      const thaw = createDeferredCore<boolean>();
      checkTelemetryUpdateMock.mockReturnValue(check.promise);
      const restartRunningChannels = vi.fn(
        (_mode: "new-thaw" | "deferred-retry", _shouldContinue?: () => boolean) => thaw.promise,
      );
      const state = createGatewayMaintenanceStateForTest();
      const refreshGatewayHealthSnapshot = vi.fn(state.refreshGatewayHealthSnapshot);
      const broadcast = vi.fn();
      const runWorktreeGc = vi.fn(async () => undefined);
      const runDeliveryQueueMediaGc = vi.fn(async () => undefined);
      const logHealth = { info: vi.fn(), error: vi.fn() };
      const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
      const timers = startGatewayMaintenanceTimers({
        ...state,
        restartRunningChannels,
        refreshGatewayHealthSnapshot,
        broadcast,
        runWorktreeGc,
        runDeliveryQueueMediaGc,
        runManagedOutgoingMediaGc: async () => undefined,
        logHealth,
      });
      try {
        vi.setSystemTime(Date.now() + 75_000);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(checkTelemetryUpdateMock).toHaveBeenCalledOnce();
        expect(restartRunningChannels).toHaveBeenCalledOnce();
        if (drain === "restart") {
          markGatewayRestartDraining();
        }
        let stopped = false;
        const stopping = timers.stopPeriodicTasks().then(() => {
          stopped = true;
        });
        refreshGatewayHealthSnapshot.mockRejectedValue(
          new Error("Gateway health refresh owner is closed"),
        );
        broadcast.mockClear();
        state.dedupe.set("retained-during-drain", { ts: 0, ok: true });
        thaw.resolve(true);

        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

        expect(logHealth.error).not.toHaveBeenCalled();
        expect(refreshGatewayHealthSnapshot).toHaveBeenCalledOnce();
        expect(broadcast).not.toHaveBeenCalled();
        expect(runWorktreeGc).toHaveBeenCalledOnce();
        expect(runDeliveryQueueMediaGc).toHaveBeenCalledOnce();
        expect(checkTelemetryUpdateMock).toHaveBeenCalledOnce();
        expect(state.dedupe.has("retained-during-drain")).toBe(true);
        expect(restartRunningChannels.mock.calls[0]?.[1]?.()).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        check.resolve(null);
        await stopping;
        expect(stopped).toBe(true);
      } finally {
        thaw.resolve(true);
        check.resolve(null);
        await stopMaintenanceTimers(timers);
      }
    },
  );

  it("joins admitted callbacks and cleanup before reporting another periodic owner's stop failure", async () => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(0);
    const failure = new Error("cold-storage stop failed");
    const coldStorage = await import("./session-cold-storage-maintenance.js");
    const startColdStorage = coldStorage.startSessionColdStorageMaintenance;
    vi.spyOn(coldStorage, "startSessionColdStorageMaintenance").mockImplementation((params) => {
      const owner = startColdStorage(params);
      const stop = owner.stop;
      owner.stop = async () => {
        await stop();
        throw failure;
      };
      return owner;
    });
    const operation = createDeferredCore();
    const cleanup = createDeferredCore();
    const cleanupStarted = createDeferredCore();
    let cleanupWork: Promise<void> | undefined;
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      runWorktreeGc: async () => {
        await operation.promise;
        cleanupWork = trackAsyncWork(() => cleanup.promise);
        cleanupStarted.resolve();
      },
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });
    let settled = false;
    const stopping = timers.stopPeriodicTasks().then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      operation.resolve();
      await cleanupStarted.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      cleanup.resolve();

      const error = await stopping;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ errors: [failure] });
    } finally {
      operation.resolve();
      cleanup.resolve();
      await cleanupStarted.promise;
      await cleanupWork;
      await stopping;
      await timers.skillUsageCleanup();
    }
  });

  it("uses one jittered maintenance schedule and silently retries failed checks", async () => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(150_000);
    checkTelemetryUpdateMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(null);
    const logHealth = { info: vi.fn(), error: vi.fn() };
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const maintenanceState = createGatewayMaintenanceStateForTest();
    const timers = startGatewayMaintenanceTimers({
      ...maintenanceState,
      logHealth,
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });

    expect(generateSecureIntMock).toHaveBeenNthCalledWith(1, 5 * 60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledWith(maintenanceState.getRuntimeConfig, {
      surface: "gateway",
    });
    expect(checkTelemetryUpdateMock.mock.lastCall?.[0]()).toEqual({});
    expect(logHealth.error).not.toHaveBeenCalled();
    expect(generateSecureIntMock).toHaveBeenNthCalledWith(2, 5 * 60_000);

    await vi.advanceTimersByTimeAsync(420_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("coalesces pending checks and joins them before stopping future telemetry admission", async () => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(0);
    const check = createDeferredCore<null>();
    checkTelemetryUpdateMock.mockReturnValue(check.promise);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopping = timers.stopPeriodicTasks().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(stopped).toBe(false);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);

      check.resolve(null);
      await stopping;
      expect(stopped).toBe(true);
      await timers.stopPeriodicTasks();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);
    } finally {
      check.resolve(null);
      await stopMaintenanceTimers(timers);
    }
  });

  it("never checks telemetry for Nix-managed gateways", async () => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(0);
    const broadcast = vi.fn();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      broadcast,
      isNixMode: true,
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith("tick", { ts: expect.any(Number) });
    await stopMaintenanceTimers(timers);
  });
});
