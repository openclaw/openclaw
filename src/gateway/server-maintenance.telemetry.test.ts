import "./server-worker-free.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  devicePairCleanupMock:
    vi.fn<typeof import("../infra/device-bootstrap.js").startDevicePairSetupMaintenance>(),
  forbiddenDefaultAdapter: vi.fn((adapter: string): never => {
    throw new Error(`Unexpected default maintenance adapter: ${adapter}`);
  }),
}));

vi.mock("../infra/secure-random.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/secure-random.js")>()),
  generateSecureInt: generateSecureIntMock,
}));

// mock-isolation: Inject scheduled device work to test shutdown without a database worker.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: devicePairCleanupMock,
}));

vi.mock("../infra/telemetry.js", () => ({
  checkTelemetryUpdate: checkTelemetryUpdateMock,
}));

// These default readers are unused by the supplied callbacks and native work fixture.
vi.mock("../agents/worktrees/owner-protection.js", () => ({
  createManagedWorktreeOwnerPolicy: () => forbiddenDefaultAdapter("worktree owner policy"),
}));

// mock-isolation: Worker-free timers inject GC and reject accidental default worktree access.
vi.mock("../agents/worktrees/service.js", () => ({
  WORKTREE_GC_INTERVAL_MS: 60 * 60_000,
  managedWorktrees: { gc: () => forbiddenDefaultAdapter("worktree GC") },
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

// mock-isolation: Worker-free maintenance must reject default chat-abort work instead of mutating live controller state.
vi.mock("./chat-abort.js", () => ({
  abortChatRunById: () => forbiddenDefaultAdapter("chat abort"),
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

type TimerOptions = Parameters<
  typeof import("./server-maintenance.js").startGatewayMaintenanceTimers
>[0];

function createMaintenanceDeps() {
  const state = createGatewayMaintenanceStateForTest();
  return {
    ...state,
    broadcast: vi.fn(),
    refreshGatewayHealthSnapshot: vi.fn(state.refreshGatewayHealthSnapshot),
    logHealth: { info: vi.fn(), error: vi.fn() },
    runWorktreeGc: vi.fn(async (): Promise<void> => {}),
    runDeliveryQueueMediaGc: vi.fn(async (): Promise<void> => {}),
    runManagedOutgoingMediaGc: vi.fn(async (): Promise<void> => {}),
  };
}

async function startMaintenance(params: TimerOptions) {
  const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
  return startGatewayMaintenanceTimers(params);
}

async function stopMaintenanceTimers(
  timers: Awaited<ReturnType<typeof startMaintenance>>,
  failure?: Error,
): Promise<void> {
  const stopping = timers.stopPeriodicTasks();
  await (failure ? expect(stopping).rejects.toMatchObject({ errors: [failure] }) : stopping);
  await timers.skillUsageCleanup();
}

describe("gateway telemetry maintenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(0);
  });
  afterEach(() => {
    const defaultAdapterCalls = forbiddenDefaultAdapter.mock.calls;
    forbiddenDefaultAdapter.mockClear();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
    checkTelemetryUpdateMock.mockReset();
    generateSecureIntMock.mockReset();
    devicePairCleanupMock.mockReset();
    expect(defaultAdapterCalls).toHaveLength(0);
  });

  it.each([
    ["health", false],
    ["worktree", false],
    ["device-pair", false],
    ["worktree", true],
  ] as const)(
    "joins admitted %s work and cleanup before settling stop (failure=%s)",
    async (owner, fails) => {
      checkTelemetryUpdateMock.mockResolvedValue(null);
      const failure = fails ? new Error("cold-storage stop failed") : undefined;
      if (failure) {
        const coldStorage = await import("./session-cold-storage-maintenance.js");
        const start = coldStorage.startSessionColdStorageMaintenance;
        vi.spyOn(coldStorage, "startSessionColdStorageMaintenance").mockImplementation((params) => {
          const maintenance = start(params);
          const stop = maintenance.stop;
          maintenance.stop = async () => {
            await stop();
            throw failure;
          };
          return maintenance;
        });
      }
      const blockedCall = fails || owner === "device-pair" ? 1 : 2;
      const operation = createDeferredCore();
      const cleanup = createDeferredCore();
      const cleanupStarted = createDeferredCore();
      let calls = 0;
      let cleanupWork: Promise<void> | undefined;
      const run = async () => {
        calls += 1;
        if (calls !== blockedCall) {
          return;
        }
        await operation.promise;
        cleanupWork = trackAsyncWork(() => cleanup.promise);
        cleanupStarted.resolve();
      };
      const state = createMaintenanceDeps();
      if (owner === "health") {
        state.clients.add({
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "test", version: "test", platform: "test", mode: "test" },
          },
        });
      } else if (owner === "worktree") {
        state.runWorktreeGc.mockImplementation(run);
      }
      devicePairCleanupMock.mockImplementation(({ scheduler }) => {
        if (owner === "device-pair") {
          scheduler.schedule({ id: "device-pair-test", atMs: scheduler.now(), run });
        }
      });
      const timers = await startMaintenance({
        ...state,
        refreshGatewayHealthSnapshot: async () => {
          if (owner === "health") {
            await run();
          }
          return await state.refreshGatewayHealthSnapshot();
        },
      });
      try {
        await vi.advanceTimersByTimeAsync(
          owner === "worktree" ? blockedCall * 60 * 60_000 + 1 : 60_000,
        );
        expect(calls).toBe(blockedCall);
        if (!fails) {
          markGatewayRestartDraining();
        }
        const stopped = vi.fn();
        const stopping = timers
          .stopPeriodicTasks()
          .catch((error: unknown) => error)
          .finally(stopped);
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).not.toHaveBeenCalled();

        operation.resolve();
        await cleanupStarted.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).not.toHaveBeenCalled();

        cleanup.resolve();
        const error = await stopping;
        if (failure) {
          expect(error).toBeInstanceOf(AggregateError);
          expect(error).toMatchObject({ errors: [failure] });
        } else {
          expect(error).toBeUndefined();
        }
      } finally {
        operation.resolve();
        cleanup.resolve();
        await stopMaintenanceTimers(timers, failure);
        await cleanupWork;
      }
    },
  );

  it.each(["restart", "local", "scheduler"] as const)(
    "retires periodic producers at %s drain before their owners close",
    async (drain) => {
      vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 0, system: 0 });
      const check = createDeferredCore<null>();
      const thaw = createDeferredCore<boolean>();
      checkTelemetryUpdateMock.mockReturnValue(check.promise);
      const restartRunningChannels = vi.fn<TimerOptions["restartRunningChannels"]>(
        () => thaw.promise,
      );
      const state = createMaintenanceDeps();
      const {
        runWorktreeGc,
        runDeliveryQueueMediaGc,
        logHealth,
        refreshGatewayHealthSnapshot,
        broadcast,
      } = state;
      const timers = await startMaintenance({ ...state, restartRunningChannels });
      try {
        vi.setSystemTime(Date.now() + 75_000);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(checkTelemetryUpdateMock).toHaveBeenCalledOnce();
        expect(restartRunningChannels).toHaveBeenCalledOnce();
        if (drain === "restart") {
          markGatewayRestartDraining();
        } else if (drain === "scheduler") {
          state.scheduler.beginClose();
          expect(restartRunningChannels.mock.calls[0]?.[1]?.()).toBe(false);
        }
        const stopped = vi.fn();
        const stopping = timers.stopPeriodicTasks().finally(stopped);
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
        expect(runWorktreeGc).not.toHaveBeenCalled();
        expect(runDeliveryQueueMediaGc).not.toHaveBeenCalled();
        expect(checkTelemetryUpdateMock).toHaveBeenCalledOnce();
        expect(state.dedupe.has("retained-during-drain")).toBe(true);
        expect(restartRunningChannels.mock.calls[0]?.[1]?.()).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).not.toHaveBeenCalled();
        check.resolve(null);
        await stopping;
      } finally {
        thaw.resolve(true);
        check.resolve(null);
        await stopMaintenanceTimers(timers);
      }
    },
  );

  it("jitter-retries failed checks, coalesces pending checks and joins them on stop", async () => {
    generateSecureIntMock.mockReturnValue(150_000);
    const check = createDeferredCore<null>();
    checkTelemetryUpdateMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValue(check.promise);
    const maintenanceState = createMaintenanceDeps();
    const { logHealth } = maintenanceState;
    const timers = await startMaintenance(maintenanceState);

    expect(generateSecureIntMock).toHaveBeenNthCalledWith(1, 5 * 60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledWith(maintenanceState.getRuntimeConfig);
    expect(logHealth.error).not.toHaveBeenCalled();
    expect(generateSecureIntMock).toHaveBeenNthCalledWith(2, 5 * 60_000);

    await vi.advanceTimersByTimeAsync(420_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);

    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);
      const stopped = vi.fn();
      const stopping = timers.stopPeriodicTasks().finally(stopped);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(stopped).not.toHaveBeenCalled();
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);
      check.resolve(null);
      await stopping;
      await timers.stopPeriodicTasks();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);
    } finally {
      check.resolve(null);
      await stopMaintenanceTimers(timers);
    }
  });

  it("never checks telemetry for Nix-managed gateways", async () => {
    const state = createMaintenanceDeps();
    const timers = await startMaintenance({ ...state, isNixMode: true });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(state.broadcast).toHaveBeenCalledWith("tick", { ts: expect.any(Number) });
    await stopMaintenanceTimers(timers);
  });
});
