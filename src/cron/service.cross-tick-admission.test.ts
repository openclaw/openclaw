// Cron cross-tick admission tests prove newly due jobs are collected on a
// later timer tick while an earlier batch is still executing (#119083).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import { createCronServiceState } from "./service/state.js";
import { MAX_TIMER_DELAY_MS } from "./service/timer-execution-timeout.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-cross-tick-admission-",
});

type CronStateParams = Parameters<typeof createCronServiceState>[0] & {
  testAdmissionLimit?: number;
};

function createAdmissionTestState(params: CronStateParams) {
  const { testAdmissionLimit, ...stateParams } = params;
  const state = createCronServiceState(stateParams);
  if (testAdmissionLimit !== undefined) {
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - testAdmissionLimit;
  }
  return state;
}

describe("cron service cross-tick admission", () => {
  it("admits a newly due job on a later timer tick while an earlier batch is still running", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const t0 = Date.parse("2026-02-06T10:05:00.000Z");
    const jobA = createDueIsolatedJob({
      id: "cross-tick-job-a",
      nowMs: t0,
      nextRunAtMs: t0,
    });
    const jobB = createDueIsolatedJob({
      id: "cross-tick-job-b",
      nowMs: t0,
      nextRunAtMs: t0 + 60_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [jobA, jobB] });

    let now = t0;
    const aStarted = createDeferred<void>();
    const releaseA = createDeferred<{ status: "ok"; summary: string }>();
    const bStarted = createDeferred<void>();
    const releaseB = createDeferred<{ status: "ok"; summary: string }>();

    let active = 0;
    let peakActive = 0;
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (job.id === jobA.id) {
        aStarted.resolve();
        const result = await releaseA.promise;
        active -= 1;
        return result;
      }
      bStarted.resolve();
      const result = await releaseB.promise;
      active -= 1;
      return result;
    });

    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    // First timer tick at T0: collects job A, blocks on deferred.
    const tick1 = onTimer(state);
    await aStarted.promise;

    // Advance time so job B becomes due.
    now = t0 + 60_000;

    // Second timer tick: must collect and start job B even though tick1 is
    // still running. The scheduler must drop the batch-wide running gate and
    // let the admission pool gate concurrency instead.
    const tick2 = onTimer(state);
    await bStarted.promise;

    // Job B started while job A is still running — cross-tick admission works.
    expect(peakActive).toBe(2);

    // Release B first, then A.
    releaseB.resolve({ status: "ok", summary: "b done" });
    releaseA.resolve({ status: "ok", summary: "a done" });
    await Promise.all([tick1, tick2]);

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.find((job) => job.id === jobA.id)?.state.lastRunStatus).toBe("ok");
    expect(persisted.jobs.find((job) => job.id === jobB.id)?.state.lastRunStatus).toBe("ok");
    expect(persisted.jobs.every((job) => job.state.queuedAtMs === undefined)).toBe(true);
    expect(persisted.jobs.every((job) => job.state.runningAtMs === undefined)).toBe(true);
  });

  describe("fake-timer lifecycle", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("admits a newly due job via the timer lifecycle when an earlier batch is still running", async () => {
      vi.useFakeTimers();
      const t0 = Date.parse("2026-02-06T10:05:00.000Z");
      vi.setSystemTime(t0);

      const store = opsRegressionFixtures.makeStorePath();
      // Disable the wall-clock timeout on job A by setting timeoutSeconds:0.
      // The CRON_AGENT_SETUP_WATCHDOG_MS (60 s) is the same as
      // MAX_TIMER_DELAY_MS; advancing fake timers by 60 s would otherwise
      // fire the setup watchdog and prematurely fail job A.
      const jobA = createDueIsolatedJob({
        id: "cross-tick-lifecycle-a",
        nowMs: t0,
        nextRunAtMs: t0,
      });
      jobA.payload = { kind: "agentTurn", message: jobA.id, timeoutSeconds: 0 };
      const jobB = createDueIsolatedJob({
        id: "cross-tick-lifecycle-b",
        nowMs: t0,
        nextRunAtMs: t0 + MAX_TIMER_DELAY_MS,
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [jobA, jobB] });

      let tick2TriggeredAt = 0;
      const aStarted = createDeferred<void>();
      const releaseA = createDeferred<{ status: "ok"; summary: string }>();
      const bStarted = createDeferred<void>();
      const releaseB = createDeferred<{ status: "ok"; summary: string }>();

      let active = 0;
      let peakActive = 0;
      let runCallCount = 0;
      const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
        active += 1;
        runCallCount += 1;
        peakActive = Math.max(peakActive, active);
        if (job.id === jobA.id) {
          aStarted.resolve();
          const result = await releaseA.promise;
          active -= 1;
          return result;
        }
        tick2TriggeredAt = Date.now();
        bStarted.resolve();
        const result = await releaseB.promise;
        active -= 1;
        return result;
      });

      const state = createAdmissionTestState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => Date.now(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });

      // First tick: onTimer collects job A and blocks on the deferred.
      // armRunningRecheckTimer sets a 60 s fake-timer timeout internally.
      const tick1 = onTimer(state);
      await aStarted.promise;
      expect(runCallCount).toBe(1);

      // Advance the fake clock by MAX_TIMER_DELAY_MS.  The recheck timer
      // fires through the real setCronTimer path (setTimeout → onTimer),
      // proving the scheduler allows cross-tick admission via the actual
      // timer lifecycle rather than only via a direct onTimer handler call.
      vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
      // Flush microtasks so the second tick's runner is called.
      await Promise.resolve();
      await Promise.resolve();
      await bStarted.promise;

      // Both jobs were admitted concurrently through the timer lifecycle.
      // peakActive proves job B started before job A released its slot.
      expect(runCallCount).toBe(2);
      expect(peakActive).toBe(2);

      // tick2 started after the fake clock advanced past T0 + MAX_TIMER_DELAY_MS.
      expect(tick2TriggeredAt).toBeGreaterThanOrEqual(t0 + MAX_TIMER_DELAY_MS);

      // Release B first so tick2's activeTimerTicks decrements, then A.
      releaseB.resolve({ status: "ok", summary: "b done" });
      releaseA.resolve({ status: "ok", summary: "a done" });
      await tick1;
      // Drain microtasks from tick2 completion (no direct promise handle).
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      const persisted = await loadCronStore(store.storePath);
      expect(persisted.jobs.find((job) => job.id === jobA.id)?.state.lastRunStatus).toBe("ok");
      expect(persisted.jobs.find((job) => job.id === jobB.id)?.state.lastRunStatus).toBe("ok");
      expect(persisted.jobs.every((job) => job.state.queuedAtMs === undefined)).toBe(true);
      expect(persisted.jobs.every((job) => job.state.runningAtMs === undefined)).toBe(true);
    });
  });
});
