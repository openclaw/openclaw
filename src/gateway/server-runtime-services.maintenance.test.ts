import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import {
  createMaintenanceHandles,
  createPostReadyMaintenanceScheduleParams,
  resetRuntimeServiceMocks,
  runtimeServiceMocks,
} from "./server-runtime-services.test-harness.js";

// mock-isolation: Scheduler tests must not start channel or transcript repair lifetimes.
vi.mock("./server-startup-plugins.js", () => ({
  runGatewayPostReadyStartupMaintenance: vi.fn(async () => {}),
}));

const { scheduleGatewayPostReadyMaintenance } = await import("./server-runtime-services.js");

beforeEach(() => {
  resetGatewayWorkAdmission();
  resetRuntimeServiceMocks();
});
afterEach(resetGatewayWorkAdmission);

function createMaintenanceTest(withConnection = false) {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const connectionWork = new GatewayConnectionWork();
  const params = createPostReadyMaintenanceScheduleParams({
    scheduler,
    ...(withConnection && {
      signal: connectionWork.signal,
      isClosing: () => connectionWork.signal.aborted,
    }),
  });
  const schedule = (overrides: Partial<typeof params> = {}) =>
    scheduleGatewayPostReadyMaintenance({ ...params, ...overrides });
  return { ...params, cron: params.cronState.cron, clock, scheduler, connectionWork, schedule };
}

describe("post-ready maintenance scheduling", () => {
  it("defers optional database work during recovery without delaying cron or timers", async () => {
    const test = createMaintenanceTest();
    const ready = createDeferredCore();
    const finishRecovery = createDeferredCore();
    let recovery: Promise<void> | undefined;
    const { runGatewayPostReadyStartupMaintenance } = await import("./server-startup-plugins.js");
    vi.mocked(runGatewayPostReadyStartupMaintenance).mockClear();
    test.schedule({ waitForPostReadyWork: () => ready.promise });
    try {
      const pending = test.clock.advanceBy(1);
      await Promise.resolve();
      recovery = enqueueCommandInLane("background", () => finishRecovery.promise);
      ready.resolve();
      await pending;
      expect(runGatewayPostReadyStartupMaintenance).not.toHaveBeenCalled();
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).not.toHaveBeenCalled();
      expect(test.startMaintenance).toHaveBeenCalledOnce();
      expect(test.cron.start).toHaveBeenCalledOnce();
      finishRecovery.resolve();
      await recovery;
      await test.clock.advanceBy(1_000);
      await test.clock.advanceBy(1_000);
      expect(runGatewayPostReadyStartupMaintenance).toHaveBeenCalledOnce();
      expect(test.cron.start).toHaveBeenCalledOnce();
    } finally {
      ready.resolve();
      finishRecovery.resolve();
      await recovery;
      await test.scheduler.stop();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "warms after readiness, repeats, and cancels with its Gateway",
    async () => {
      const test = createMaintenanceTest(true);
      const ready = createDeferredCore();
      test.schedule({ waitForPostReadyWork: () => ready.promise });
      const pending = test.clock.advanceBy(1);
      await Promise.resolve();
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).not.toHaveBeenCalled();
      ready.resolve();
      await pending;
      await test.clock.advanceBy(1_000);
      await test.clock.advanceBy(1_000);
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).toHaveBeenCalledTimes(1);
      await test.clock.advanceBy(15 * 60 * 1000);
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).toHaveBeenCalledTimes(2);
      test.connectionWork.beginClose();
      await test.scheduler.stop();
      await test.clock.advanceBy(15 * 60 * 1000);
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).toHaveBeenCalledTimes(2);
    },
  );

  it("starts cron and records memory when post-ready maintenance fails", async () => {
    const test = createMaintenanceTest();

    test.schedule({
      startMaintenance: () => Promise.reject(new Error("timers unavailable")),
    });
    await test.clock.advanceBy(1);

    expect(test.log.warn).toHaveBeenCalledWith(
      "gateway post-ready maintenance startup failed: Error: timers unavailable",
    );
    expect(test.cron.start).toHaveBeenCalledTimes(1);
    expect(test.recordPostReadyMemory).toHaveBeenCalledTimes(1);
  });

  it("clears delayed maintenance handles when close starts during maintenance startup", async () => {
    const test = createMaintenanceTest(true);
    const started = createDeferredCore();
    const pendingMaintenance = createDeferredCore<ReturnType<typeof createMaintenanceHandles>>();
    const startMaintenance = vi.fn(() => {
      started.resolve();
      return pendingMaintenance.promise;
    });

    test.schedule({ delayMs: 25, startMaintenance });

    const pendingWake = test.clock.advanceBy(25);
    await started.promise;
    expect(startMaintenance).toHaveBeenCalledTimes(1);

    test.connectionWork.beginClose();
    const stopped = vi.fn<() => void>();
    const stopping = test.scheduler.stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    const maintenance = createMaintenanceHandles();
    pendingMaintenance.resolve(maintenance);
    await pendingWake;
    await stopping;

    expect(test.applyMaintenance).not.toHaveBeenCalled();
    expect(maintenance.startMediaCleanup).not.toHaveBeenCalled();
    expect(maintenance.stopPeriodicTasks).toHaveBeenCalledTimes(1);
    expect(test.cron.start).not.toHaveBeenCalled();
    expect(test.recordPostReadyMemory).not.toHaveBeenCalled();
  });

  it("cancels unadmitted maintenance without reopening the suspension fence", async ({
    signal,
  }) => {
    const test = createMaintenanceTest(true);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const release = () => suspension?.release();
    signal.addEventListener("abort", release, { once: true });
    test.schedule();
    const pendingWake = test.clock.advanceBy(1);
    try {
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      test.scheduler.beginClose();
      test.connectionWork.beginClose();
      await test.scheduler.stop();
      await pendingWake;
      expect(test.startMaintenance).not.toHaveBeenCalled();
      expect(test.log.warn).not.toHaveBeenCalled();
    } finally {
      release();
      test.connectionWork.beginClose();
      await test.scheduler.stop();
      signal.removeEventListener("abort", release);
    }
  });
});
