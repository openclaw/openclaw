import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

type IdleTaskOptions = Parameters<typeof scheduleGatewayIdleTask>[0];
function schedule(overrides: Pick<IdleTaskOptions, "run"> & Partial<IdleTaskOptions>) {
  return scheduleGatewayIdleTask({
    id: "test:idle",
    scheduler,
    delayMs: 10,
    retryDelayMs: 5,
    isClosing: () => false,
    isBusy: () => false,
    log: { warn: vi.fn() },
    errorMessage: "idle task failed",
    ...overrides,
  });
}

it.each(["ordinary", "draining", "error"] as const)("settles %s idle work", async (mode) => {
  const error = new GatewayDrainingError("unexpected task failure");
  const run = vi.fn(async () => {
    if (mode === "error") {
      throw error;
    }
  });
  const warn = vi.fn();
  const handle = schedule({ run, log: { warn } });
  if (mode === "draining") {
    markGatewayRestartDraining();
  }
  await clock.advanceBy(10);
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(mode === "draining" ? 0 : 1);
  expect(warn.mock.calls).toEqual(mode === "error" ? [[`idle task failed: ${String(error)}`]] : []);
  expect(scheduler.nextWakeAtMs).toBeNull();
  await handle.stop();
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
  const handle = schedule({ repeatDelayMs: 20, isBusy, run });
  try {
    await clock.advanceBy(10);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).not.toBeNull();
    isBusy.mockReturnValue(true);
    await clock.advanceBy(20);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).not.toBeNull();
    isBusy.mockReturnValue(false);
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
  const handle = schedule({ delayMs: 0, repeatDelayMs: 20, run });
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
