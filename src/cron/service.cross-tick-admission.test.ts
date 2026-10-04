// Scheduled work must use free shared-admission slots across timer ticks (#119083).
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  beginGatewayRestartSignalAdmission,
  GatewayDrainingError,
  runWithGatewayIndependentRootWorkAdmission,
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
  tryBeginGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { start, stop } from "./service/ops-lifecycle.js";
import { run } from "./service/ops-run.js";
import { observeCronTimerAdmissions } from "./service/run-recovery.test-support.js";
import { onTimer } from "./service/timer.test-support.js";
import * as cronStoreModule from "./store.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import {
  finishCronRunReceiptAsync,
  prepareCronRunReceiptClaim,
} from "./store/run-receipt-store.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  inspectActiveCronRunReceipt,
} from "./store/run-receipt-store.test-support.js";
import type { CronRunReceiptHandle } from "./store/run-receipt.types.js";
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

  it("keeps saturated work unreserved and its capacity wake independently admitted", async () => {
    const t0 = Date.parse("2026-02-06T10:06:00.000Z");
    const jobA = dueJob("saturated-a", t0);
    const jobB = dueJob("saturated-b", t0);
    const jobC = dueJob("saturated-later", t0, t0 + 60_000);
    const store = await seedJobs([jobA, jobB, jobC]);

    let now = t0;
    const blocked = blockedRuns([jobA, jobB, jobC]);
    const runIsolatedAgentJob = blocked.run;
    const clock = createGatewaySchedulerClock(t0);
    const capacityWakeArmed = createDeferred();
    const scheduler = createTestGatewayScheduler({
      ...clock.clock,
      arm: (wake, delayMs) => {
        const cancel = clock.clock.arm(wake, delayMs);
        if (delayMs === 0) {
          capacityWakeArmed.resolve();
        }
        return cancel;
      },
    });
    const state = createCronRegressionState({
      scheduler,
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });
    state.runAdmission.active = 8 - 2;

    const firstTick = onTimer(state);
    await Promise.all([blocked.started(jobA), blocked.started(jobB)]);
    expect(store.receipt(jobA)).toBeDefined();
    expect(store.receipt(jobB)).toBeDefined();
    now = t0 + 60_000;

    await Promise.all([onTimer(state), onTimer(state), onTimer(state)]);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(state.activeTimerTicks).toBe(1);
    expect(state.runAdmission.waiters).toHaveLength(0);
    expect(state.runAdmission.capacityListener).toBeTypeOf("function");
    expect(state.queuedRunReservationsByJobId.has(jobC.id)).toBe(false);
    expect(store.receipt(jobC)).toBeUndefined();
    const saturatedStore = await loadCronStore(store.storePath);
    expect(saturatedStore.jobs.find((job) => job.id === jobC.id)?.state.queuedAtMs).toBeUndefined();
    expect(
      saturatedStore.jobs.find((job) => job.id === jobC.id)?.state.runningAtMs,
    ).toBeUndefined();

    blocked.release(jobA);
    await capacityWakeArmed.promise;
    const capacityTick = clock.advanceBy(0);
    await blocked.started(jobC);
    expect(getActiveGatewayRootWorkCount()).toBe(2);
    expect(store.receipt(jobC)).toBeDefined();
    expect(state.runAdmission.capacityListener).toBeNull();
    expect(blocked.peakActive).toBe(2);

    blocked.release(jobB);
    await firstTick;
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    blocked.release(jobC);
    await capacityTick;
    expect(state.activeTimerTicks).toBe(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(state.queuedRunReservationsByJobId.size).toBe(0);
    expect(store.receipt(jobC)).toBeUndefined();
    stop(state);
  });

  it("retires an empty tick when a receipt conflict leaves the same jobs due", async () => {
    const t0 = Date.parse("2026-02-06T10:07:00.000Z");
    const conflicted = dueJob("unchanged-conflict", t0);
    const pending = dueJob("after-unchanged-conflict", t0);
    const store = await seedJobs([conflicted, pending]);
    const prepared = prepareCronRunReceiptClaim({
      observed: undefined,
      storePath: store.storePath,
      job: conflicted,
      agentId: conflicted.agentId ?? "main",
      startedAtMs: t0,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabaseForTest({
        database: db,
        prepared,
        resolveAgentId: (job) => job.agentId ?? "main",
      }),
    );
    let peakTicks = 0;
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const clock = createGatewaySchedulerClock(t0);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const state: ReturnType<typeof createCronRegressionState> = createCronRegressionState({
      scheduler,
      storePath: store.storePath,
      nowMs: () => {
        peakTicks = Math.max(peakTicks, state.activeTimerTicks);
        // A timer cannot stop a microtask livelock; bound the pre-fix failure here.
        if (peakTicks >= 5) {
          stop(state);
        }
        return t0;
      },
      runIsolatedAgentJob,
    });
    state.runAdmission.active = 8 - 1;

    const unrelated = tryBeginGatewayIndependentRootWorkAdmission("test:concurrent-request");
    expect(unrelated).not.toBeNull();
    const admissions = observeCronTimerAdmissions(state);

    try {
      await onTimer(state);

      expect(peakTicks).toBe(1);
      expect(state.stopped).toBe(false);
      expect(state.activeTimerTicks).toBe(0);
      await admissions.expectReleased(1);
      expect(state.runAdmission.active).toBe(8 - 1);
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(state.timer).not.toBeNull();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();

      await finishCronRunReceiptAsync({ handle: receipt, status: "skipped", finishedAtMs: t0 });
      await onTimer(state);

      await clock.advanceBy(0);
      // The resumed tick rechecks capacity to run the second due job.
      await admissions.expectReleased(3);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      expect(state.activeTimerTicks).toBe(0);
      expect(
        (await loadCronStore(store.storePath)).jobs.every(
          (job) => job.state.lastRunStatus === "ok",
        ),
      ).toBe(true);
    } finally {
      unrelated!.release();
      await finishCronRunReceiptAsync({ handle: receipt, status: "skipped", finishedAtMs: t0 });
      stop(state);
    }
  });

  it("rechecks a partial batch immediately when its only reservation conflicts", async () => {
    const t0 = Date.parse("2026-02-06T10:07:30.000Z");
    const conflicted = dueJob("partial-conflict", t0);
    const pending = dueJob("partial-after-conflict", t0);
    const store = await seedJobs([conflicted, pending]);

    const foreignStartedAtMs = t0 + 1;
    const preparedForeignReceipt = prepareCronRunReceiptClaim({
      observed: undefined,
      storePath: store.storePath,
      job: conflicted,
      agentId: conflicted.agentId ?? "main",
      startedAtMs: foreignStartedAtMs,
    });
    let foreignReceipt: CronRunReceiptHandle | undefined;
    let nowCalls = 0;
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      expect(job.id).toBe(pending.id);
      return { status: "ok" as const, summary: "pending done" };
    });
    const clock = createGatewaySchedulerClock(t0);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const state = createCronRegressionState({
      scheduler,
      storePath: store.storePath,
      nowMs: () => {
        nowCalls += 1;
        // The third scheduler time read occurs after due-job collection and
        // immediately before receipt reservation. Simulate a sibling winning
        // the durable owner race at that boundary.
        if (nowCalls === 3) {
          foreignReceipt = runOpenClawStateWriteTransaction(({ db }) => {
            const receipt = claimCronRunReceiptInDatabaseForTest({
              database: db,
              prepared: preparedForeignReceipt,
              resolveAgentId: (job) => job.agentId ?? "main",
            });
            db.prepare(
              `UPDATE cron_jobs
                  SET state_json = json_set(state_json, '$.runningAtMs', ?),
                      updated_at = updated_at + 1
                WHERE store_key = ? AND job_id = ?`,
            ).run(foreignStartedAtMs, cronStoreKey(store.storePath), conflicted.id);
            return receipt;
          });
        }
        return t0;
      },
      runIsolatedAgentJob,
    });
    state.runAdmission.active = 8 - 1;

    try {
      await onTimer(state);
      await clock.advanceBy(0);

      expect(foreignReceipt).toBeDefined();
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(state.runAdmission.active).toBe(8 - 1);
      expect(state.runAdmission.capacityListener).toBeNull();
      expect(state.activeTimerTicks).toBe(0);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((job) => job.id === pending.id)?.state,
      ).toMatchObject({ lastRunStatus: "ok" });
    } finally {
      if (foreignReceipt) {
        await finishCronRunReceiptAsync({
          handle: foreignReceipt,
          status: "interrupted",
          finishedAtMs: t0 + 2,
        });
      }
      stop(state);
    }
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
    state.runAdmission.active = 8 - 2;

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
      expect(getActiveGatewayRootWorkCount()).toBe(2);

      blocked.release(jobA);
      await tickA;
      expect(
        getActiveGatewayRootWorkCount(),
        JSON.stringify(getActiveGatewayRootWorkHolders()),
      ).toBe(1);
      blocked.release(jobB);
      await tickB;
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
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
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

  it("gives a waiter-delayed partial-batch wake an independent Gateway root", async () => {
    const t0 = Date.parse("2026-02-06T10:09:00.000Z");
    const scheduledA = dueJob("delayed-listener-scheduled-a", t0);
    const scheduledB = dueJob("delayed-listener-scheduled-b", t0);
    const pending = dueJob("delayed-listener-pending", t0);
    const directA = dueJob("delayed-listener-direct-a", t0, t0 + 3_600_000);
    const directB = dueJob("delayed-listener-direct-b", t0, t0 + 3_600_000);
    const store = await seedJobs([scheduledA, scheduledB, pending, directA, directB]);

    const blocked = blockedRuns([scheduledA, scheduledB, pending, directA, directB]);
    const pendingStarted = createDeferred();
    const clock = createGatewaySchedulerClock(t0);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const state = createCronRegressionState({
      scheduler,
      storePath: store.storePath,
      nowMs: () => t0,
      onEvent: (event) => {
        if (event.jobId === pending.id && event.action === "started") {
          pendingStarted.resolve();
        }
      },
      runIsolatedAgentJob: blocked.run,
    });
    state.runAdmission.active = 8 - 2;

    const timerRun = onTimer(state);
    let directRunA: Promise<unknown> | undefined;
    let directRunB: Promise<unknown> | undefined;
    try {
      await Promise.all([blocked.started(scheduledA), blocked.started(scheduledB)]);
      expect(store.receipt(pending)).toBeUndefined();
      directRunA = runWithGatewayIndependentRootWorkAdmission(() =>
        run(state, directA.id, "force"),
      );
      directRunB = runWithGatewayIndependentRootWorkAdmission(() =>
        run(state, directB.id, "force"),
      );
      await vi.waitFor(() => expect(state.runAdmission.waiters).toHaveLength(2));

      blocked.release(scheduledA);
      blocked.release(scheduledB);
      await Promise.all([blocked.started(directA), blocked.started(directB)]);
      await timerRun;

      expect(state.runAdmission.capacityListener).toBeTypeOf("function");
      expect(
        getActiveGatewayRootWorkCount(),
        `Active Gateway roots: ${JSON.stringify(getActiveGatewayRootWorkHolders())}`,
      ).toBe(2);

      blocked.release(directA);
      await directRunA;
      const capacityTick = clock.advanceBy(0);
      // The capacity wake still observes active receipts before admitting pending work.
      await pendingStarted.promise;
      await blocked.started(pending);
      expect(blocked.run.mock.calls.filter(([{ job }]) => job.id === pending.id)).toHaveLength(1);
      await directRunA;

      expect(getActiveGatewayRootWorkCount()).toBe(2);

      blocked.release(directB);
      await directRunB;

      expect(getActiveGatewayRootWorkCount()).toBe(1);

      blocked.release(pending);
      await capacityTick;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(state.activeTimerTicks).toBe(0);
    } finally {
      blocked.release(scheduledA);
      blocked.release(scheduledB);
      blocked.release(directA);
      blocked.release(directB);
      blocked.release(pending);
      await Promise.allSettled([
        timerRun,
        directRunA ?? Promise.resolve(),
        directRunB ?? Promise.resolve(),
      ]);
      stop(state);
    }
  });

  it("gives an open partial-batch wake its own Gateway root", async () => {
    const t0 = Date.parse("2026-02-06T10:09:30.000Z");
    const scheduledA = dueJob("open-listener-scheduled-a", t0);
    const scheduledB = dueJob("open-listener-scheduled-b", t0);
    const pending = dueJob("open-listener-pending", t0);
    const direct = dueJob("open-listener-direct", t0, t0 + 3_600_000);
    const store = await seedJobs([scheduledA, scheduledB, pending, direct]);

    const blocked = blockedRuns([scheduledA, scheduledB, direct]);
    const pendingStarted = createDeferred();
    const directRootRetired = createDeferred();
    const subordinateResult = createDeferred<unknown>();
    const clock = createGatewaySchedulerClock(t0);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const state = createCronRegressionState({
      scheduler,
      storePath: store.storePath,
      nowMs: () => t0,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: CronJob }) => {
        if (job.id !== pending.id) {
          return await blocked.run({ job });
        }
        pendingStarted.resolve();
        await directRootRetired.promise;
        try {
          await enqueueCommandInLane("cron-open-listener-subordinate", async () => {});
          subordinateResult.resolve("accepted");
          return { status: "ok" as const, summary: "pending" };
        } catch (error) {
          subordinateResult.resolve(error);
          throw error;
        }
      }),
    });
    state.runAdmission.active = 8 - 2;

    const timerRun = onTimer(state);
    let directRun: Promise<unknown> | undefined;
    try {
      await Promise.all([blocked.started(scheduledA), blocked.started(scheduledB)]);
      directRun = runWithGatewayIndependentRootWorkAdmission(() => run(state, direct.id, "force"));
      await vi.waitFor(() => expect(state.runAdmission.waiters).toHaveLength(1));

      blocked.release(scheduledA);
      await blocked.started(direct);
      expect(state.runAdmission.capacityListener).toBeTypeOf("function");
      expect(getActiveGatewayRootWorkCount()).toBe(2);

      blocked.release(direct);
      await directRun;
      const capacityTick = clock.advanceBy(0);
      await pendingStarted.promise;
      await directRun;
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      directRootRetired.resolve();

      const result = await subordinateResult.promise;
      expect(result).not.toBeInstanceOf(GatewayDrainingError);
      expect(result).toBe("accepted");
      await capacityTick;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      directRootRetired.resolve();
      blocked.release(scheduledA);
      blocked.release(scheduledB);
      blocked.release(direct);
      await Promise.allSettled([timerRun, directRun ?? Promise.resolve()]);
      stop(state);
    }
  });

  it("refills capacity immediately after a clean post-reservation skip", async () => {
    const t0 = Date.parse("2026-02-06T10:10:00.000Z");
    const skipped = dueJob("post-reservation-skip", t0);
    const pending = dueJob("post-reservation-pending", t0);
    const store = await seedJobs([skipped, pending]);

    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      expect(job.id).toBe(pending.id);
      return { status: "ok" as const, summary: "pending" };
    });
    const clock = createGatewaySchedulerClock(t0);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const state = createCronRegressionState({
      scheduler,
      storePath: store.storePath,
      nowMs: () => t0,
      runIsolatedAgentJob,
    });
    state.runAdmission.active = 8 - 1;

    const realLoad = cronStoreModule.loadCronJobsStoreWithConfigJobs;
    let queuedReloads = 0;
    const loadSpy = vi
      .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
      .mockImplementation(async (storePath) => {
        const loaded = await realLoad(storePath);
        const skippedJob = loaded.store.jobs.find((job) => job.id === skipped.id);
        if (skippedJob?.state.queuedAtMs !== undefined) {
          queuedReloads += 1;
          if (queuedReloads === 2) {
            skippedJob.enabled = false;
            await saveCronStore(storePath, loaded.store);
          }
        }
        return loaded;
      });

    try {
      await onTimer(state);
      await clock.advanceBy(0);

      expect(queuedReloads).toBeGreaterThanOrEqual(2);
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(state.runAdmission.capacityListener).toBeNull();
      expect(state.runAdmission.active).toBe(8 - 1);
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      const persisted = await loadCronStore(store.storePath);
      expect(persisted.jobs.find((job) => job.id === skipped.id)?.enabled).toBe(false);
      expect(persisted.jobs.find((job) => job.id === pending.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      loadSpy.mockRestore();
      stop(state);
    }
  });
});
