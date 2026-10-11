import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState as createCronServiceState,
  createDefaultIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createMainRegressionJob as mainJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import {
  advanceCronActiveJobGeneration,
  clearCronJobActive,
  isCronJobActive,
  markCronJobActive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import {
  readCronRunHistoryPageForTests,
  readCronRunRecordsForTests,
} from "../run-history.test-support.js";
import * as schedule from "../schedule.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import type { CronJob } from "../types.js";
import { getSuspensionVisibleCronTaskRunCount } from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";
import { computeJobNextRunAtMs, recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { stop } from "./ops-lifecycle.js";
import { run as runManualCronJob } from "./ops-run.js";
import type { CronEvent, CronServiceDeps } from "./state.js";
import { executeJobCoreWithTimeout, runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const timerRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timer-regressions-",
});

function dueJob(id: string, nowMs: number, nextRunAtMs = nowMs) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs });
}

async function storeJobs(jobs: CronJob[]) {
  const { storePath } = timerRegressionFixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs });
  return storePath;
}

async function drain(...runs: Promise<unknown>[]) {
  await Promise.allSettled(runs);
  await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
}

function requireJob(state: { store?: { jobs?: CronJob[] } | null }, id: string): CronJob {
  const job = state.store?.jobs?.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`expected cron job ${id}`);
  }
  return job;
}

function requireTimestamp(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`expected ${label} timestamp`);
  }
  return value;
}

function requireAdmittedRunId(storePath: string, jobId: string): string {
  const receipt = inspectActiveCronRunReceipt({ storePath, jobId });
  if (!receipt) {
    throw new Error("Expected an admitted cron receipt");
  }
  return `cron:${jobId}:${receipt.startedAtMs}:${receipt.receiptId}`;
}

describe("cron service timer regressions", () => {
  it("#131491: retains a deleteAfterRun one-shot whose stale guard suppressed its delivery", async () => {
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");
    const firedAt = scheduledAt + 18 * 60 * 60_000;

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-stale-delivery",
      name: "late report",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "summarize and report" },
      state: { nextRunAtMs: scheduledAt },
    });
    cronJob.deleteAfterRun = true;
    const storePath = await storeJobs([cronJob]);

    // Execution succeeded, but the delivery owner rejected its stale output.
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "ok",
      summary: "report finished",
      outputText: "report finished",
      delivered: false,
      deliveryAttempted: true,
      deliveryState: {
        delivered: false,
        status: "not-delivered",
        error: "skipping stale delivery scheduled at 2026-02-06T10:00:00.000Z, started 1080m late",
        failureNotification: { status: "not-requested" },
      },
    });
    const state = createCronServiceState({
      storePath,
      nowMs: () => firedAt,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs).toHaveLength(1);
    const job = requireJob({ store: persisted }, cronJob.id);
    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDelivered).toBe(false);
    expect(job.state.lastDeliveryStatus).toBe("not-delivered");
    expect(job.state.lastDeliveryError).toContain("skipping stale delivery");

    // A fresh scheduler must retain the evidence without replaying completed work.
    stop(state);
    const restarted = createCronServiceState(state.deps);
    await onTimer(restarted);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect((await loadCronStore(storePath)).jobs).toEqual(persisted.jobs);
    stop(restarted);
  });

  it("#24355: one-shot job disabled after max transient retries", async () => {
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-max-retries",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    cronJob.deleteAfterRun = true;
    const storePath = await storeJobs([cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "429 rate limit exceeded",
    });
    const state = createCronServiceState({
      storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });

    for (let i = 0; i < 4; i += 1) {
      await onTimer(state);
      const job = requireJob(state, "oneshot-max-retries");
      if (i < 3) {
        expect(job.enabled).toBe(true);
        now = requireTimestamp(job.state.nextRunAtMs, "max-retries next run") + 1;
      } else {
        expect(job.enabled).toBe(false);
      }
    }
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(4);
  });

  it("enforces a minimum refire gap for second-granularity cron schedules (#17821)", async () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "spin-gap-17821",
      name: "second-granularity",
      scheduledAt,
      schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "pulse" },
      state: { nextRunAtMs: scheduledAt },
    });
    const storePath = await storeJobs([cronJob]);

    let now = scheduledAt;
    const state = createCronServiceState({
      storePath,
      nowMs: () => now,
      runIsolatedAgentJob: vi.fn(async () => {
        now += 100;
        return { status: "ok" as const, summary: "done" };
      }),
    });

    await onTimer(state);

    const job = requireJob(state, "spin-gap-17821");
    const endedAt = now;
    expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(endedAt + 2_000);
    await onTimer(state);
    expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledOnce();
  });

  it("retains cancellation of a conditioned main payload after session execution begins", async () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = mainJob("main-session-cancel-boundary", scheduledAt, {
      kind: "systemEvent",
      text: "conditioned session work",
    });
    cronJob.schedule = { kind: "every", everyMs: 60_000, anchorMs: scheduledAt - 60_000 };
    cronJob.trigger = { script: "json({ fire: true })" };
    const storePath = await storeJobs([cronJob]);

    const runnerStarted = createDeferred<AbortSignal | undefined>();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
      async ({ abortSignal, onExecutionStarted }) => {
        onExecutionStarted?.({ jobId: cronJob.id, phase: "model_call_started" });
        runnerStarted.resolve(abortSignal);
        // An abort-ignoring runner must not replace the recorded cancellation.
        return await runnerResult.promise;
      },
    );
    const state = createCronServiceState({
      storePath,
      nowMs: () => scheduledAt,
      runSessionEvent,
      evaluateCronTrigger: async () => ({ kind: "evaluated", fire: true }),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    const timerPromise = onTimer(state);
    try {
      const abortSignal = await awaitGateBeforeSettlement(
        runnerStarted.promise,
        timerPromise,
        "Cron timer completed before main-session execution began",
      );
      const runId = requireAdmittedRunId(storePath, cronJob.id);
      expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: cronJob.id, sessionTarget: "main" }),
          text: "conditioned session work",
        }),
      );

      requestActiveCronJobCancellation(cronJob.id, "Cancelled by operator.");
      expect(abortSignal?.aborted).toBe(true);
      expect(inspectActiveCronRunReceipt({ storePath, jobId: cronJob.id })).toBeDefined();
      await timerPromise;

      expect(requireJob(state, cronJob.id).state).toMatchObject({
        lastStatus: "error",
        lastError: "Cancelled by operator.",
      });
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
      runnerResult.resolve({ status: "ok", summary: "late success" });
      await drain(timerPromise, runnerResult.promise);
      expect(
        readCronRunRecordsForTests(cronJob.id).filter((entry) => entry.runId === runId),
      ).toEqual([expect.objectContaining({ status: "failed", error: "Cancelled by operator." })]);
      expect(requireJob(state, cronJob.id).state.lastStatus).toBe("error");
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "late success" });
      await drain(timerPromise, runnerResult.promise);
      resetActiveCronTaskRunsForTests();
    }
  });

  it("allows cancellation of detached script work targeting the main session", async () => {
    resetActiveCronTaskRunsForTests();

    const scheduledAt = Date.parse("2026-07-18T12:00:00.000Z");
    const cronJob = mainJob("main-script-cancel-boundary", scheduledAt, {
      kind: "script",
      script: "return { notify: 'done' }",
      timeoutSeconds: 0,
    });
    const storePath = await storeJobs([cronJob]);

    let abortObserved = false;
    let timerSettled = false;
    const runnerStarted = createDeferred();
    const runnerResult = createDeferred<{
      status: "ok";
      notify: string;
      wake: "now";
    }>();
    const enqueueSystemEvent = vi.fn();
    const enqueueSessionEvent = vi.fn();
    const state = createCronServiceState({
      cronConfig: { triggers: { enabled: true } },
      storePath,
      nowMs: () => scheduledAt,
      enqueueSystemEvent,
      enqueueSessionEvent,
      captureSessionEventTarget: async () => ({
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "script-session",
        generation: "script-generation",
      }),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      runScriptJob: vi.fn(async ({ abortSignal }) => {
        runnerStarted.resolve();
        abortSignal?.addEventListener(
          "abort",
          () => {
            abortObserved = true;
          },
          { once: true },
        );
        // Deliberately ignore abort so the cron boundary must suppress any
        // late notify/wake result after operator cancellation has settled.
        return await runnerResult.promise;
      }),
    });

    const timerPromise = onTimer(state).then(() => {
      timerSettled = true;
    });
    try {
      await runnerStarted.promise;

      const runId = requireAdmittedRunId(storePath, cronJob.id);
      requestActiveCronJobCancellation(cronJob.id, "Cancelled by operator.");
      expect(abortObserved).toBe(true);

      await vi.waitFor(() => expect(timerSettled).toBe(true), { interval: 0 });
      await timerPromise;
      expect(
        readCronRunRecordsForTests(cronJob.id).find((entry) => entry.runId === runId)?.error,
      ).toBe("Cancelled by operator.");

      runnerResult.resolve({ status: "ok", notify: "stale", wake: "now" });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", notify: "stale", wake: "now" });
      await drain(timerPromise, runnerResult.promise);
      resetActiveCronTaskRunsForTests();
    }
  });

  it("retires main-target script work across restart generation advance", async () => {
    resetActiveCronTaskRunsForTests();
    const scheduledAt = Date.parse("2026-07-18T12:05:00.000Z");
    const cronJob = mainJob("main-script-generation-retire", scheduledAt, {
      kind: "script",
      script: "return { notify: 'stale' }",
      timeoutSeconds: 0,
    });
    const storePath = await storeJobs([cronJob]);

    const entered = createDeferred();
    const release = createDeferred<{ status: "ok"; notify: string }>();
    const state = createCronServiceState({
      cronConfig: { triggers: { enabled: true } },
      storePath,
      nowMs: () => scheduledAt,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      runScriptJob: vi.fn(async () => {
        entered.resolve();
        return await release.promise;
      }),
    });

    const timerPromise = onTimer(state);
    try {
      await entered.promise;
      expect(isCronJobActive(cronJob.id)).toBe(true);

      advanceCronActiveJobGeneration();
      expect(isCronJobActive(cronJob.id)).toBe(false);
      release.resolve({ status: "ok", notify: "stale" });
      await timerPromise;

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]?.state.lastStatus).not.toBe("ok");
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      stop(state);
      release.resolve({ status: "ok", notify: "stale" });
      await drain(timerPromise, release.promise);
      resetActiveCronTaskRunsForTests();
    }
  });

  it("rejects cron runner admission after its active marker generation retires", async () => {
    const { storePath } = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-05-13T12:30:00.000Z");
    const cronJob = dueJob("retired-generation-admission", scheduledAt);
    const activeJobMarker = markCronJobActive(cronJob.id);
    advanceCronActiveJobGeneration();

    const runIsolatedAgentJob = vi.fn(createDefaultIsolatedRunner());
    const state = createCronServiceState({
      storePath,
      nowMs: () => scheduledAt,
      runIsolatedAgentJob,
    });

    try {
      const result = await executeJobCoreWithTimeout(state, cronJob, { activeJobMarker });

      expect(result.status).toBe("error");
      expect(result.error).toContain("Gateway restarting");
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      clearCronJobActive(cronJob.id, activeJobMarker);
    }
  });

  it("consumes a pending cancellation before a main condition binds its controller", async () => {
    const { storePath } = timerRegressionFixtures.makeStorePath();
    const now = Date.now();
    const cronJob = dueJob("condition-cancel-before-bind", now);
    cronJob.sessionTarget = "main";
    cronJob.payload = { kind: "systemEvent", text: "must not execute" };
    cronJob.schedule = { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 };
    cronJob.trigger = { script: "json({ fire: true })" };
    const activeJobMarker = markCronJobActive(cronJob.id);
    requestActiveCronJobCancellation(cronJob.id, "Cron job disabled by operator.");
    const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
    const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      runSessionEvent,
      evaluateCronTrigger,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    try {
      await expect(
        executeJobCoreWithTimeout(state, cronJob, { activeJobMarker }),
      ).resolves.toMatchObject({
        status: "error",
        error: "Cron job disabled by operator.",
      });
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      expect(runSessionEvent).not.toHaveBeenCalled();
    } finally {
      clearCronJobActive(cronJob.id, activeJobMarker);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
  });

  it("settles a recurring main job only after ordinary session admission completes (#75964)", async () => {
    const scheduledAt = Date.now();
    const job = mainJob("busy-recurring-main", scheduledAt, { kind: "systemEvent", text: "tick" });
    job.schedule = { kind: "cron", expr: "*/3 * * * *", tz: "UTC", staggerMs: 0 };
    const storePath = await storeJobs([job]);
    const queued = createDeferred();
    const admitted = createDeferred();
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
      async ({ onLaneWait, onExecutionStarted }) => {
        onLaneWait?.({ waiting: true });
        queued.resolve();
        await admitted.promise;
        onLaneWait?.({ waiting: false });
        onExecutionStarted?.({ jobId: job.id, phase: "model_call_started" });
        return { status: "ok", summary: "tick delivered", delivered: true };
      },
    );
    const events: CronEvent[] = [];
    const state = createCronServiceState({
      storePath,
      nowMs: () => scheduledAt,
      runSessionEvent,
      onEvent: (event) => events.push(event),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    const runPromise = onTimer(state);
    try {
      await awaitGateBeforeSettlement(
        queued.promise,
        runPromise,
        "Cron timer completed before ordinary session admission",
      );
      const runId = requireAdmittedRunId(storePath, job.id);
      expect(requireJob(state, job.id).state.runningAtMs).toBe(scheduledAt);
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(true);
      expect(events.filter((event) => event.action === "finished")).toEqual([]);

      admitted.resolve();
      await runPromise;
      const persistedJob = requireJob({ store: await loadCronStore(storePath) }, job.id);
      expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id, sessionTarget: "main" }),
          text: "tick",
        }),
      );
      expect(persistedJob.state).toMatchObject({
        lastStatus: "ok",
        lastDelivered: true,
        lastDeliveryStatus: "delivered",
      });
      expect(persistedJob.state.runningAtMs).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(events.filter((event) => event.action === "finished")).toEqual([
        expect.objectContaining({
          jobId: job.id,
          status: "ok",
          summary: "tick delivered",
          delivered: true,
          deliveryStatus: "delivered",
        }),
      ]);
      expect(readCronRunRecordsForTests(job.id).filter((entry) => entry.runId === runId)).toEqual([
        expect.objectContaining({ status: "succeeded" }),
      ]);
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
    } finally {
      stop(state);
      admitted.resolve();
      await drain(runPromise);
    }
  });

  it("retries cron schedule computation from the next second when the first attempt returns undefined (#17821)", () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = createIsolatedRegressionJob({
      id: "retry-next-second-17821",
      name: "retry",
      scheduledAt,
      schedule: { kind: "cron", expr: "0 13 * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "briefing" },
    });

    const original = schedule.computeNextRunAtMs;
    const spy = vi.spyOn(schedule, "computeNextRunAtMs");
    try {
      spy
        .mockImplementationOnce(() => undefined)
        .mockImplementation((sched, nowMs) => original(sched, nowMs));

      const expected = requireTimestamp(
        original(cronJob.schedule, scheduledAt + 1_000),
        "next-second retry",
      );

      const next = computeJobNextRunAtMs(cronJob, scheduledAt);
      expect(next).toBe(expected);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps capacity-blocked scheduled work unreserved until a slot opens", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:01.250Z");
    const first = dueJob("scheduled-active", dueAt);
    const second = dueJob("scheduled-queued", dueAt);
    const storePath = await storeJobs([first, second]);

    let now = dueAt;
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred<{ status: "ok"; summary: string }>();
    const secondStarted = createDeferred();
    const releaseSecond = createDeferred<{ status: "ok"; summary: string }>();
    const clock = createGatewaySchedulerClock(dueAt);
    const capacityWakeArmed = createDeferred();
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler({
        ...clock.clock,
        arm: (wake, delayMs) => {
          const cancel = clock.clock.arm(wake, delayMs);
          if (delayMs === 0) {
            capacityWakeArmed.resolve();
          }
          return cancel;
        },
      }),
      storePath,
      testAdmissionLimit: 1,
      nowMs: () => now,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: { id: string } }) => {
        if (job.id === first.id) {
          firstStarted.resolve();
          return await releaseFirst.promise;
        }
        secondStarted.resolve();
        return await releaseSecond.promise;
      }),
    });

    const timerRun = onTimer(state);
    try {
      await firstStarted.promise;
      expect(requireJob(state, second.id).state.queuedAtMs).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.has(second.id)).toBe(false);
      now += 2 * 60 * 60 * 1000 + 1;
      recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });
      expect(requireJob(state, second.id).state.queuedAtMs).toBeUndefined();

      releaseFirst.resolve({ status: "ok", summary: "first" });
      await capacityWakeArmed.promise;
      const capacityTick = clock.advanceBy(0);
      await secondStarted.promise;
      const secondStartedAt = now;
      expect(requireJob(state, second.id).state.runningAtMs).toBe(secondStartedAt);
      expect(
        (await loadCronStore(storePath))?.jobs.find((job) => job.id === second.id)?.state
          .runningAtMs,
      ).toBe(secondStartedAt);
      expect(state.queuedRunReservationsByJobId.has(second.id)).toBe(true);
      now += 2 * 60 * 60 * 1000 + 1;
      recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });
      expect(requireJob(state, second.id).state.runningAtMs).toBe(secondStartedAt);
      now += 100;
      releaseSecond.resolve({ status: "ok", summary: "second" });

      await Promise.all([timerRun, capacityTick]);
      const completedSecond = state.store?.jobs.find((job) => job.id === second.id);
      expect(completedSecond?.state.lastRunAtMs).toBe(secondStartedAt);
      expect(completedSecond?.state.lastDurationMs).toBe(2 * 60 * 60 * 1000 + 101);
      expect(state.queuedRunReservationsByJobId.has(second.id)).toBe(false);
    } finally {
      stop(state);
      releaseFirst.resolve({ status: "ok", summary: "first" });
      releaseSecond.resolve({ status: "ok", summary: "second" });
      await drain(timerRun, releaseFirst.promise, releaseSecond.promise);
    }
  });

  it("rechecks startup catch-up eligibility after an admission wait", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:01.437Z");
    const activeManualJob = dueJob(
      "manual-before-rescheduled-startup-catchup",
      dueAt,
      dueAt + 3_600_000,
    );
    const catchupJob = dueJob("rescheduled-startup-catchup", dueAt);
    const storePath = await storeJobs([activeManualJob, catchupJob]);

    const activeStarted = createDeferred();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      if (job.id === activeManualJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "should not run" };
    });
    const state = createCronServiceState({
      storePath,
      testAdmissionLimit: 1,
      nowMs: () => dueAt,
      runIsolatedAgentJob,
    });

    const activeRun = runManualCronJob(state, activeManualJob.id, "force");
    let catchupRun: ReturnType<typeof runMissedJobs> | undefined;
    try {
      await activeStarted.promise;
      catchupRun = runMissedJobs(state);
      await vi.waitFor(() => {
        expect(requireJob(state, catchupJob.id).state.queuedAtMs).toBe(dueAt);
      });

      const rescheduledStore = await loadCronStore(storePath);
      const rescheduledJob = rescheduledStore.jobs.find((job) => job.id === catchupJob.id);
      if (!rescheduledJob) {
        throw new Error("Expected startup catch-up job");
      }
      rescheduledJob.state.nextRunAtMs = dueAt + 3_600_000;
      await saveCronStore(storePath, rescheduledStore);

      releaseActive.resolve({ status: "ok", summary: "manual" });
      await Promise.all([activeRun, catchupRun]);

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(requireJob(state, catchupJob.id).state.runningAtMs).toBeUndefined();
      expect(
        (await loadCronStore(storePath)).jobs.find((job) => job.id === catchupJob.id)?.state
          .runningAtMs,
      ).toBeUndefined();
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(storePath), catchupJob.id) as { status: string } | undefined;
      expect(receipt?.status).toBe("skipped");
    } finally {
      stop(state);
      releaseActive.resolve({ status: "ok", summary: "manual" });
      await drain(activeRun, ...(catchupRun ? [catchupRun] : []), releaseActive.promise);
    }
  });

  it("does not start an admitted due job after stop wins its service-lock wait", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:01.500Z");
    const job = dueJob("stopped-due-service-lock", dueAt);
    const storePath = await storeJobs([job]);

    const releaseServiceLock = createDeferred();
    const serviceLockHeld = createDeferred();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      testAdmissionLimit: 1,
      nowMs: () => dueAt,
      runIsolatedAgentJob,
    });
    let currentOperation = state.op;
    let holdNextOperation = true;
    Object.defineProperty(state, "op", {
      configurable: true,
      get: () => currentOperation,
      set: (operation: Promise<unknown>) => {
        if (holdNextOperation) {
          holdNextOperation = false;
          currentOperation = releaseServiceLock.promise;
          serviceLockHeld.resolve();
          return;
        }
        currentOperation = operation;
      },
    });

    const timerRun = onTimer(state);
    try {
      await serviceLockHeld.promise;
      stop(state);
      releaseServiceLock.resolve();
      await timerRun;

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      stop(state);
      releaseServiceLock.resolve();
      await drain(timerRun, releaseServiceLock.promise);
    }
  });

  it("notifies a stalled batch once without releasing its executing sibling", async () => {
    const dueAt = Date.parse("2026-02-06T10:06:21.000Z");
    const stalled = dueJob("setup-timeout-stalled", dueAt);
    const running = dueJob("setup-timeout-running-sibling", dueAt);
    stalled.payload = { kind: "agentTurn", message: "stall", timeoutSeconds: 120 };
    running.payload = { kind: "agentTurn", message: "run", timeoutSeconds: 120 };
    const secondStalled = { ...stalled, id: "setup-timeout-second-stalled" };
    const storePath = await storeJobs([stalled, secondStalled, running]);

    let now = dueAt;
    const allStarted = createDeferred();
    let startedCount = 0;
    const finishRunning = createDeferred<{ status: "ok"; summary: string }>();
    const timeoutNotified = createDeferred();
    const onIsolatedAgentSetupTimeout = vi.fn(() => timeoutNotified.resolve());
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      storePath,
      testAdmissionLimit: 3,
      nowMs: () => now,
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(
        async ({
          job,
          onExecutionStarted,
        }: Parameters<CronServiceDeps["runIsolatedAgentJob"]>[0]) => {
          if (++startedCount === 3) {
            allStarted.resolve();
          }
          if (job.id !== running.id) {
            return await runnerResult.promise;
          }
          onExecutionStarted?.({ jobId: job.id, phase: "model_call_started" });
          return await finishRunning.promise;
        },
      ),
    });

    const timerPromise = onTimer(state);
    try {
      await allStarted.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timeoutNotified.promise;

      const runningAtMsAfterRecovery = requireJob(state, running.id).state.runningAtMs;
      const reservationHeldAfterRecovery = state.queuedRunReservationsByJobId.has(running.id);
      finishRunning.resolve({ status: "ok", summary: "finished" });
      await timerPromise;

      expect({ runningAtMsAfterRecovery, reservationHeldAfterRecovery }).toEqual({
        runningAtMsAfterRecovery: dueAt,
        reservationHeldAfterRecovery: true,
      });
      expect(requireJob(state, running.id).state.lastStatus).toBe("ok");
      expect(requireJob(state, stalled.id).state.lastStatus).toBe("error");
      expect(requireJob(state, secondStalled.id).state.lastStatus).toBe("error");
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledExactlyOnceWith({
        job: expect.objectContaining({ id: expect.stringMatching(/^setup-timeout-.*stalled$/) }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      finishRunning.resolve({ status: "ok", summary: "finished" });
      await drain(timerPromise, runnerResult.promise, finishRunning.promise);
    }
  });

  it("notifies timeout recovery before admitting queued manual work", async () => {
    const dueAt = Date.parse("2026-02-06T10:06:31.000Z");
    const first = dueJob("serial-timeout-recovery-first", dueAt);
    const second = dueJob("serial-timeout-recovery-second", dueAt, dueAt + 3_600_000);
    first.payload = { kind: "agentTurn", message: "first", timeoutSeconds: 120 };
    second.payload = { kind: "agentTurn", message: "second", timeoutSeconds: 120 };
    const storePath = await storeJobs([first, second]);

    let now = dueAt;
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      storePath,
      testAdmissionLimit: 1,
      nowMs: () => now,
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: CronJob }) => {
        if (job.id === first.id) {
          firstStarted.resolve();
          return await runnerResult.promise;
        }
        expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledOnce();
        secondStarted.resolve();
        return { status: "ok" as const, summary: "second after recovery" };
      }),
    });

    const timerPromise = onTimer(state);
    let manualRun: ReturnType<typeof runManualCronJob> | undefined;
    try {
      await firstStarted.promise;
      manualRun = runManualCronJob(state, second.id, "force");
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await secondStarted.promise;
      await manualRun;
      await timerPromise;

      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledOnce();
      expect(requireJob(state, first.id).state.lastStatus).toBe("error");
      expect(requireJob(state, second.id).state.lastStatus).toBe("ok");
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      await drain(timerPromise, ...(manualRun ? [manualRun] : []), runnerResult.promise);
    }
  });

  it("recovers stopped catch-up outcomes without overwriting replacement reservations", async () => {
    const scheduledAt = Date.parse("2026-05-10T08:58:45.000Z");
    const job = dueJob("stopped-startup-catchup", scheduledAt);
    const unstartedJob = dueJob("unstarted-stopped-startup-catchup", scheduledAt);
    const replacementClaimedJob = dueJob(
      "replacement-claimed-stopped-startup-catchup",
      scheduledAt,
    );
    const storePath = await storeJobs([job, unstartedJob, replacementClaimedJob]);

    const runStarted = createDeferred();
    const releaseRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      storePath,
      nowMs: () => scheduledAt,
      runIsolatedAgentJob: async () => {
        runStarted.resolve();
        return await releaseRun.promise;
      },
    });

    const missedJobs = runMissedJobs(state);
    try {
      await runStarted.promise;

      state.stopped = true;
      const replacementReservationMs = scheduledAt + 123;
      const replacementStore = await loadCronStore(storePath);
      const replacementPersistedJob = replacementStore.jobs.find(
        (entry) => entry.id === replacementClaimedJob.id,
      );
      if (!replacementPersistedJob) {
        throw new Error("expected replacement-claimed startup job");
      }
      replacementPersistedJob.state.queuedAtMs = replacementReservationMs;
      await saveCronStore(storePath, replacementStore);

      releaseRun.resolve({ status: "ok", summary: "old service result" });
      await missedJobs;

      const persisted = await loadCronStore(storePath);
      const persistedJob = persisted.jobs.find((entry) => entry.id === job.id);
      const persistedUnstartedJob = persisted.jobs.find((entry) => entry.id === unstartedJob.id);
      const persistedReplacementClaimedJob = persisted.jobs.find(
        (entry) => entry.id === replacementClaimedJob.id,
      );
      expect(persistedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedJob?.state.lastStatus).toBe("ok");
      expect(persistedUnstartedJob?.state.runningAtMs).toBeUndefined();
      expect(persistedUnstartedJob?.state.lastStatus).toBeUndefined();
      expect(persistedReplacementClaimedJob?.state.queuedAtMs).toBe(replacementReservationMs);
      expect(persistedReplacementClaimedJob?.state.lastStatus).toBeUndefined();
      expect(readCronRunRecordsForTests().find((entry) => entry.jobId === job.id)?.status).toBe(
        "succeeded",
      );
    } finally {
      stop(state);
      releaseRun.resolve({ status: "ok", summary: "old service result" });
      await drain(missedJobs, releaseRun.promise);
    }
  });

  it("starts the scheduled batch after manual setup-timeout notification", async () => {
    const scheduledAt = Date.parse("2026-05-10T08:59:00.000Z");
    const manualJob = dueJob(
      "manual-setup-timeout-active-batch",
      scheduledAt,
      scheduledAt + 3_600_000,
    );
    manualJob.payload = { kind: "agentTurn", message: "manual", timeoutSeconds: 120 };
    const firstScheduledJob = dueJob("scheduled-before-manual-recovery", scheduledAt);
    const secondScheduledJob = dueJob("scheduled-blocked-by-manual-recovery", scheduledAt);
    const storePath = await storeJobs([manualJob, firstScheduledJob, secondScheduledJob]);

    vi.setSystemTime(scheduledAt);
    let now = scheduledAt;
    const manualStarted = createDeferred();
    const firstScheduledStarted = createDeferred();
    const finishFirstScheduled = createDeferred();
    const secondScheduledStarted = vi.fn();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const clock = createGatewaySchedulerClock(scheduledAt);
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath,
      testAdmissionLimit: 1,
      nowMs: () => now,
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job, onExecutionStarted }) => {
        if (job.id === manualJob.id) {
          manualStarted.resolve();
          return await runnerResult.promise;
        }
        if (job.id === firstScheduledJob.id) {
          firstScheduledStarted.resolve();
          onExecutionStarted?.();
          await finishFirstScheduled.promise;
          return { status: "ok" as const, summary: "first scheduled" };
        }
        secondScheduledStarted(job.id);
        return { status: "ok" as const, summary: "second scheduled" };
      }),
    });

    const manualRun = runManualCronJob(state, manualJob.id, "force");
    let timerRun: ReturnType<typeof onTimer> | undefined;
    let firstCapacityTick: ReturnType<typeof clock.advanceBy> = undefined;
    try {
      await manualStarted.promise;
      timerRun = onTimer(state);

      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await manualRun;
      firstCapacityTick = clock.advanceBy(0);
      await firstScheduledStarted.promise;

      finishFirstScheduled.resolve();
      await Promise.all([timerRun, firstCapacityTick]);
      await clock.advanceBy(0);
      expect(secondScheduledStarted).toHaveBeenCalledWith(secondScheduledJob.id);
      expect(requireJob(state, secondScheduledJob.id).state.lastStatus).toBe("ok");

      const second = requireJob(state, secondScheduledJob.id);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(second.state.runningAtMs).toBeUndefined();
    } finally {
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      finishFirstScheduled.resolve();
      await drain(
        manualRun,
        ...(timerRun ? [timerRun] : []),
        ...(firstCapacityTick ? [firstCapacityTick] : []),
        runnerResult.promise,
        finishFirstScheduled.promise,
      );
    }
  });

  it.each([{ status: "ok", error: undefined, taskStatus: "succeeded" }] as const)(
    "finalizes a removed job's $status outcome in operator history",
    async ({ status, error, taskStatus }) => {
      const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
      const job = dueJob(`self-removing-${status}`, dueAt);
      if (status === "ok") {
        job.delivery = { mode: "announce", channel: "telegram", to: "chat-123" };
      }
      const storePath = await storeJobs([job]);
      const events: CronEvent[] = [];
      const summary = `finished ${job.id}`;
      const state = createCronServiceState({
        storePath,
        nowMs: () => dueAt,
        onEvent: (event) => {
          events.push(event);
        },
        runIsolatedAgentJob: vi.fn(async () => {
          const persisted = await loadCronStore(storePath);
          await saveCronStore(storePath, {
            ...persisted,
            jobs: persisted.jobs.filter((entry) => entry.id !== job.id),
          });
          return { status, error, summary, delivered: status === "ok" ? true : undefined };
        }),
      });
      await onTimer(state);
      expect(state.store?.jobs).toStrictEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: job.id,
          action: "finished",
          status,
          error,
          summary,
          ...(status === "ok" ? { delivered: true, deliveryStatus: "delivered" } : {}),
        }),
      );
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries,
      ).toEqual([expect.objectContaining({ jobId: job.id, status, error })]);
      expect(readCronRunRecordsForTests().find((record) => record.jobId === job.id)?.status).toBe(
        taskStatus,
      );
    },
  );
});
