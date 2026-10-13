import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  createLog,
  createTestCronState,
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

describe("post-ready maintenance scheduling", () => {
  it.skipIf(process.platform !== "linux")(
    "warms after readiness, repeats, and cancels with its Gateway",
    async () => {
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const ready = createDeferredCore();
      const connectionWork = new GatewayConnectionWork();
      scheduleGatewayPostReadyMaintenance(
        createPostReadyMaintenanceScheduleParams({
          scheduler,
          signal: connectionWork.signal,
          isClosing: () => connectionWork.signal.aborted,
          waitForPostReadyWork: () => ready.promise,
        }),
      );
      const pending = clock.advanceBy(1);
      await Promise.resolve();
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).not.toHaveBeenCalled();
      ready.resolve();
      await pending;
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).toHaveBeenCalledTimes(1);
      await clock.advanceBy(15 * 60 * 1000);
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).toHaveBeenCalledTimes(2);
      connectionWork.beginClose();
      await scheduler.stop();
      await clock.advanceBy(15 * 60 * 1000);
      expect(runtimeServiceMocks.warmGatewayDatabasePageCache).toHaveBeenCalledTimes(2);
    },
  );

  it("starts cron and records memory when post-ready maintenance fails", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();
    const recordPostReadyMemory = vi.fn();

    scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        scheduler,
        startMaintenance: vi.fn(async () => {
          throw new Error("timers unavailable");
        }),
        cronState: createTestCronState(cron),
        log,
        recordPostReadyMemory,
      }),
    );
    await clock.advanceBy(1);

    expect(log.warn).toHaveBeenCalledWith(
      "gateway post-ready maintenance startup failed: Error: timers unavailable",
    );
    expect(cron.start).toHaveBeenCalledTimes(1);
    expect(recordPostReadyMemory).toHaveBeenCalledTimes(1);
  });

  it("clears delayed maintenance handles when close starts during maintenance startup", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const connectionWork = new GatewayConnectionWork();
    const started = createDeferredCore();
    const pendingMaintenance = createDeferredCore<ReturnType<typeof createMaintenanceHandles>>();
    const startMaintenance = vi.fn(() => {
      started.resolve();
      return pendingMaintenance.promise;
    });
    const applyMaintenance = vi.fn();
    const cron = { start: vi.fn(async () => undefined) };
    const recordPostReadyMemory = vi.fn();

    scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        scheduler,
        signal: connectionWork.signal,
        delayMs: 25,
        isClosing: () => connectionWork.signal.aborted,
        startMaintenance,
        applyMaintenance,
        cronState: createTestCronState(cron),
        recordPostReadyMemory,
      }),
    );

    const pendingWake = clock.advanceBy(25);
    await started.promise;
    expect(startMaintenance).toHaveBeenCalledTimes(1);

    connectionWork.beginClose();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const maintenance = createMaintenanceHandles();
    pendingMaintenance.resolve(maintenance);
    await pendingWake;
    await stopping;

    expect(applyMaintenance).not.toHaveBeenCalled();
    expect(maintenance.startMediaCleanup).not.toHaveBeenCalled();
    expect(maintenance.stopPeriodicTasks).toHaveBeenCalledTimes(1);
    expect(cron.start).not.toHaveBeenCalled();
    expect(recordPostReadyMemory).not.toHaveBeenCalled();
  });

  it("cancels unadmitted maintenance without reopening the suspension fence", async ({
    signal,
  }) => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const connectionWork = new GatewayConnectionWork();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const release = () => suspension?.release();
    signal.addEventListener("abort", release, { once: true });
    const startMaintenance = vi.fn(async () => null);
    const log = createLog();
    scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        scheduler,
        signal: connectionWork.signal,
        isClosing: () => connectionWork.signal.aborted,
        startMaintenance,
        log,
      }),
    );
    const pendingWake = clock.advanceBy(1);
    try {
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      scheduler.beginClose();
      connectionWork.beginClose();
      await scheduler.stop();
      await pendingWake;
      expect(startMaintenance).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      release();
      connectionWork.beginClose();
      await scheduler.stop();
      signal.removeEventListener("abort", release);
    }
  });
});
