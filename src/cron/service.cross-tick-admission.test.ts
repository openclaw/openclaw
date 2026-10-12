// Timer producers and detached runs retain separate Gateway roots.
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { start, stop } from "./service/ops-lifecycle.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import type { CronJob } from "./types.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-cross-tick-admission-",
});

function dueJob(id: string, nowMs: number, nextRunAtMs = nowMs) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs });
}

async function seedJobs(jobs: CronJob[]) {
  const store = fixtures.makeStorePath();
  await saveCronStore(store.storePath, { version: 1, jobs });
  return {
    ...store,
    receipt: (job: CronJob) =>
      inspectActiveCronRunReceipt({ storePath: store.storePath, jobId: job.id }),
  };
}

function blockedRuns(jobs: CronJob[]) {
  const held = new Map(
    jobs.map((job) => [
      job.id,
      {
        started: createDeferred(),
        result: createDeferred<{ status: "ok"; summary: string }>(),
      },
    ]),
  );
  const lookup = (job: CronJob) => {
    const entry = held.get(job.id);
    if (!entry) {
      throw new Error(`unexpected cron job ${job.id}`);
    }
    return entry;
  };
  let active = 0;
  let peakActive = 0;
  return {
    run: vi.fn(async ({ job }: { job: CronJob }) => {
      const entry = lookup(job);
      active++;
      peakActive = Math.max(peakActive, active);
      entry.started.resolve();
      try {
        return await entry.result.promise;
      } finally {
        active--;
      }
    }),
    started: (job: CronJob) => lookup(job).started.promise,
    release: (job: CronJob) => lookup(job).result.resolve({ status: "ok", summary: job.id }),
    get peakActive() {
      return peakActive;
    },
  };
}

describe("cron service cross-tick admission", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("runs the next future wake under its own Gateway root while an earlier batch runs", async () => {
    const t0 = Date.now();
    const clock = createGatewaySchedulerClock(t0);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const jobA = dueJob("timer-a", t0);
    jobA.payload = { kind: "agentTurn", message: jobA.id, timeoutSeconds: 0 };
    const jobB = dueJob("timer-b", t0, t0 + 500);
    const store = await seedJobs([jobA, jobB]);

    const blocked = blockedRuns([jobA, jobB]);
    const runIsolatedAgentJob = blocked.run;
    const state = createCronRegressionState({
      scheduler,
      storePath: store.storePath,
      nowMs: clock.clock.now,
      runIsolatedAgentJob,
    });

    const tickA = onTimer(state);
    let tickB: ReturnType<typeof clock.advanceTo> = undefined;
    try {
      await blocked.started(jobA);
      const nextWakeAtMs = scheduler.nextWakeAtMs;
      assert.isNotNull(nextWakeAtMs);
      expect(nextWakeAtMs).toBeGreaterThanOrEqual(t0 + 500);
      tickB = clock.advanceTo(nextWakeAtMs);
      await blocked.started(jobB);

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      expect(blocked.peakActive).toBe(2);
      expect(store.receipt(jobB)).toBeDefined();
      expect(getActiveGatewayRootWorkHolders().toSorted()).toEqual([
        "cron:run (2)",
        "cron:timer-tick (2)",
      ]);

      blocked.release(jobA);
      await tickA;
      expect(state.activeTimerTicks).toBe(1);
      blocked.release(jobB);
      await tickB;
      await waitForCronRunQueue(state);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(state.activeTimerTicks).toBe(0);
    } finally {
      blocked.release(jobA);
      blocked.release(jobB);
      await Promise.all([tickA, tickB]);
      stop(state);
      await scheduler.stop();
    }
  });
  it("retires a suspended timer across a scheduler stop and restart", async () => {
    let nowMs = Date.parse("2026-02-06T10:08:00.000Z");
    const job = dueJob("retired-scheduler-timer", nowMs, nowMs + 1_000);
    const store = await seedJobs([job]);

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => nowMs,
      runIsolatedAgentJob,
    });
    await start(state);
    const restartSignal = beginGatewayRestartSignalAdmission();
    expect(restartSignal).not.toBeNull();
    const retiredTimer = onTimer(state);

    try {
      stop(state);
      await retiredTimer;
      await start(state);
      const restartedTimer = state.timer;
      nowMs += 1_000;

      expect(restartSignal?.rollback()).toBe(true);
      await retiredTimer;

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.timer).toBe(restartedTimer);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      const persisted = await loadCronStore(store.storePath);
      expect(persisted.jobs[0]?.state).toMatchObject({ nextRunAtMs: nowMs });
      expect(persisted.jobs[0]?.state.queuedAtMs).toBeUndefined();
      expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
    } finally {
      restartSignal?.rollback();
      stop(state);
      await retiredTimer;
    }
  });
});
