import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: GatewayScheduler;
beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
});

afterEach(async () => {
  await scheduler.stop();
  resetGatewayWorkAdmission();
});

describe("scheduleGatewayIdleTask", () => {
  it("still completes ordinary idle work", async () => {
    const run = vi.fn(async () => {});
    const handle = scheduleGatewayIdleTask({
      id: "test:idle",
      scheduler,
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn: vi.fn() },
      errorMessage: "idle task failed",
    });

    await clock.advanceBy(10);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.nextWakeAtMs).toBeNull();
    await handle.stop();
  });

  it("quietly cancels idle work rejected by an active restart drain", async () => {
    const run = vi.fn(async () => {});
    const warn = vi.fn();
    const handle = scheduleGatewayIdleTask({
      id: "test:idle",
      scheduler,
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn },
      errorMessage: "idle task failed",
    });

    markGatewayRestartDraining();
    await clock.advanceBy(10);

    expect(run).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBeNull();
    await handle.stop();
  });

  it("warns when idle work throws a draining error without an active restart", async () => {
    const error = new GatewayDrainingError("unexpected task failure");
    const warn = vi.fn();
    const handle = scheduleGatewayIdleTask({
      id: "test:idle",
      scheduler,
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run: async () => {
        throw error;
      },
      log: { warn },
      errorMessage: "idle task failed",
    });

    await clock.advanceBy(10);

    expect(warn).toHaveBeenCalledWith(`idle task failed: ${String(error)}`);
    await handle.stop();
  });
});

it("repeats only after completion, defers busy work once, and joins stop", async () => {
  const released = createDeferred();
  const started = createDeferred();
  const run = vi.fn(async () => {
    if (run.mock.calls.length === 2) {
      started.resolve();
      await released.promise;
    }
  });
  const isBusy = vi.fn(() => false);
  const handle = scheduleGatewayIdleTask({
    id: "test:idle",
    scheduler,
    delayMs: 10,
    retryDelayMs: 5,
    repeatDelayMs: 20,
    isClosing: () => false,
    isBusy,
    run,
    log: { warn: vi.fn() },
    errorMessage: "idle task failed",
  });
  try {
    await clock.advanceBy(10);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).not.toBeNull();
    // Admission sees idle; newly admitted foreground work wins before execution.
    isBusy.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await clock.advanceBy(20);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).not.toBeNull();
    const pendingWake = clock.advanceBy(5);
    await started.promise;
    expect(run).toHaveBeenCalledTimes(2);
    await clock.advanceBy(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.nextWakeAtMs).toBeNull();
    let stopped = false;
    const stopping = Promise.resolve(handle.stop()).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    released.resolve();
    await stopping;
    await pendingWake;
    await clock.advanceBy(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.nextWakeAtMs).toBeNull();
  } finally {
    released.resolve();
    await handle.stop();
  }
});

it("does not rearm a periodic task when restart drain begins during its run", async () => {
  const released = createDeferred();
  const started = createDeferred();
  const run = vi.fn(() => {
    started.resolve();
    return released.promise;
  });
  const handle = scheduleGatewayIdleTask({
    id: "test:idle",
    scheduler,
    delayMs: 0,
    retryDelayMs: 5,
    repeatDelayMs: 20,
    isClosing: () => false,
    isBusy: () => false,
    run,
    log: { warn: vi.fn() },
    errorMessage: "idle task failed",
  });
  try {
    const pendingWake = clock.advanceBy(0);
    await started.promise;
    expect(run).toHaveBeenCalledOnce();
    markGatewayRestartDraining();
    released.resolve();
    await pendingWake;
    await clock.advanceBy(100);
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.nextWakeAtMs).toBeNull();
  } finally {
    released.resolve();
    await handle.stop();
  }
});
