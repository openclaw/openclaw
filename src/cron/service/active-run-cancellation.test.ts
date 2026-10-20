import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearCronJobActive,
  markCronJobActive,
  noteActiveCronJobRemoval,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import {
  abortActiveCronTaskRuns,
  getSuspensionVisibleCronTaskRunCount,
  registerActiveCronTaskRun,
  retireActiveCronTaskRunTracking,
  trackActiveCronTaskRunSettlement,
  waitForActiveCronTaskRuns,
} from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";

const CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS = 60_000;
const cores: ReturnType<typeof createDeferred<void>>[] = [];
const releases: Array<() => void> = [];
function core(signal?: AbortSignal, agentId?: string) {
  const deferred = createDeferred();
  cores.push(deferred);
  trackActiveCronTaskRunSettlement(deferred.promise, signal, agentId);
  return deferred;
}
function register(params: Parameters<typeof registerActiveCronTaskRun>[0]) {
  const release = registerActiveCronTaskRun(params);
  if (release) {
    releases.push(release);
  }
  return release;
}
function marker(id: string) {
  const active = markCronJobActive(id);
  releases.push(() => clearCronJobActive(id, active));
  return active;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetActiveCronTaskRunsForTests();
});
afterEach(async () => {
  try {
    for (const release of releases.splice(0).toReversed()) {
      release();
    }
    for (const deferred of cores) {
      deferred.resolve();
    }
    await Promise.allSettled(cores.splice(0).map(({ promise }) => promise));
    await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
  } finally {
    resetActiveCronTaskRunsForTests();
    vi.useRealTimers();
  }
});

it("keeps a removed agent's unsettled core visible after cancellation and restart retirement", async () => {
  const controller = new AbortController();
  const removed = core(controller.signal, "removed");
  core(undefined, "survivor");
  controller.abort();
  await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);
  retireActiveCronTaskRunTracking();
  expect(getSuspensionVisibleCronTaskRunCount({ agentId: "removed" })).toBe(1);
  removed.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(getSuspensionVisibleCronTaskRunCount({ agentId: "removed" })).toBe(0);
  expect(getSuspensionVisibleCronTaskRunCount({ agentId: "survivor" })).toBe(1);
});

it("consumes a removal request made before the run controller binds", () => {
  const activeJobMarker = marker("removed-before-controller");
  const controller = new AbortController();
  noteActiveCronJobRemoval("removed-before-controller");
  register({ runId: "removed-before-controller-run", controller, activeJobMarker });
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe("Cron job removed by operator.");
});

it("keeps shutdown drain deadlines stable when the wall clock jumps forward", async () => {
  const initialWallTimeMs = Date.parse("2026-08-23T12:00:00.000Z");
  vi.setSystemTime(initialWallTimeMs);
  core();
  const observedDrain = vi.fn();
  const drain = waitForActiveCronTaskRuns(1_000).then(observedDrain);
  vi.setSystemTime(initialWallTimeMs + 86_400_000);
  await vi.advanceTimersByTimeAsync(999);
  expect(observedDrain).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(observedDrain).toHaveBeenCalledExactlyOnceWith({ drained: false, active: 1 });
  await drain;
});

it.each([
  { lifecycle: "registered cancellation handle", settleCore: false },
  { lifecycle: "tracked executing core", settleCore: true },
])(
  "releases concurrent shutdown drains as soon as the final $lifecycle settles",
  async ({ settleCore }) => {
    const deferred = settleCore ? core() : undefined;
    const release = settleCore
      ? undefined
      : register({ runId: "draining-handle", controller: new AbortController() });
    const firstObservedDrain = vi.fn();
    const secondObservedDrain = vi.fn();
    const drains = Promise.all([
      waitForActiveCronTaskRuns(1_000).then(firstObservedDrain),
      waitForActiveCronTaskRuns(2_000).then(secondObservedDrain),
    ]);
    if (deferred) {
      deferred.resolve();
    } else {
      release?.();
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(firstObservedDrain).toHaveBeenCalledExactlyOnceWith({ drained: true, active: 0 });
    expect(secondObservedDrain).toHaveBeenCalledExactlyOnceWith({ drained: true, active: 0 });
    await drains;
  },
);

it("drops never-settling cron promises after an abort before tracking", async () => {
  const controller = new AbortController();
  controller.abort();
  core(controller.signal);
  await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({ drained: false, active: 1 });
  await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);
  await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({ drained: true, active: 0 });
  expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
});

it("does not retire an unrelated active run when one registered run is cancelled", async () => {
  const cancelledController = new AbortController();
  const unaffectedController = new AbortController();
  core(cancelledController.signal);
  core(unaffectedController.signal);
  const release = register({
    runId: "cancelled-run",
    controller: cancelledController,
    activeJobMarker: marker("cancelled-job"),
  });
  const existingTimerCount = vi.getTimerCount();
  requestActiveCronJobCancellation("cancelled-job", "Cancelled by operator.");
  expect(cancelledController.signal.aborted).toBe(true);
  expect(cancelledController.signal.reason).toBe("Cancelled by operator.");
  expect(unaffectedController.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(existingTimerCount + 1);
  requestActiveCronJobCancellation("cancelled-job", "Repeated cancellation.");
  expect(cancelledController.signal.reason).toBe("Cancelled by operator.");
  expect(vi.getTimerCount()).toBe(existingTimerCount + 1);
  release?.();
  await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);
  await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({ drained: false, active: 1 });
  expect(getSuspensionVisibleCronTaskRunCount()).toBe(2);
});

it("retires mixed active runs during a bulk shutdown", async () => {
  const controller = new AbortController();
  core(controller.signal);
  core();
  const release = register({ runId: "shutdown-run", controller });
  expect(abortActiveCronTaskRuns()).toBe(1);
  const retirementTimerCount = vi.getTimerCount();
  expect(abortActiveCronTaskRuns()).toBe(0);
  expect(vi.getTimerCount()).toBe(retirementTimerCount);
  release?.();
  await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);
  await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({ drained: true, active: 0 });
  expect(getSuspensionVisibleCronTaskRunCount()).toBe(2);
});
