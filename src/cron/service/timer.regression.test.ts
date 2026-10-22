import { describe, expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState as createCronServiceState,
  createDefaultIsolatedRunner,
  createDueIsolatedJob,
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
import type { CronEvent, CronJob } from "../types.js";
import { getSuspensionVisibleCronTaskRunCount } from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";
import { computeJobNextRunAtMs } from "./jobs-scheduling.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { run as runManualCronJob } from "./ops-run.js";
import type { CronServiceDeps, CronServiceState } from "./state.js";
import { executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { onTimer, runMissedJobs } from "./timer.test-support.js";

const timerRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timer-regressions-",
});

function dueJob(id: string, nowMs: number, nextRunAtMs = nowMs) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs });
}

function announcingJob(id: string, at: number, jobSchedule: CronJob["schedule"]): CronJob {
  return {
    ...dueJob(id, at),
    createdAtMs: at - 86_400_000,
    updatedAtMs: at - 86_400_000,
    delivery: { mode: "announce" },
    schedule: jobSchedule,
  };
}

function conditionJob(id: string, at: number, text: string): CronJob {
  return {
    ...mainJob(id, at, { kind: "systemEvent", text }),
    schedule: { kind: "every", everyMs: 60_000, anchorMs: at - 60_000 },
    trigger: { script: "json({ fire: true })" },
  };
}

function timedJob(id: string, at: number, nextRunAtMs = at): CronJob {
  return {
    ...dueJob(id, at, nextRunAtMs),
    payload: { kind: "agentTurn", message: id, timeoutSeconds: 120 },
  };
}

function mainJob(id: string, at: number, payload: CronJob["payload"]): CronJob {
  const job = dueJob(id, at);
  delete job.delivery;
  return {
    ...job,
    name: id.replaceAll("-", " "),
    createdAtMs: at - 60_000,
    updatedAtMs: at - 60_000,
    sessionTarget: "main",
    wakeMode: "now",
    payload,
  };
}

function scriptJob(id: string, at: number, notify: string) {
  return mainJob(id, at, {
    kind: "script",
    script: `return { notify: '${notify}' }`,
    timeoutSeconds: 0,
  });
}

async function setup(
  jobs: CronJob[],
  now: number | (() => number),
  deps: Partial<CronServiceDeps> = {},
) {
  const { storePath } = timerRegressionFixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs });
  const state = createCronServiceState({
    storePath,
    nowMs: typeof now === "number" ? () => now : now,
    runIsolatedAgentJob: createDefaultIsolatedRunner(),
    ...deps,
  });
  return {
    state,
    storePath,
    persistedJob: async (id: string) => requireJob({ store: await loadCronStore(storePath) }, id),
  };
}

const ok = (summary: string) => ({ status: "ok" as const, summary });

function heldRunner<T>(fallback: T) {
  const started = createDeferred();
  const result = createDeferred<T>();
  return {
    started: started.promise,
    ...result,
    release: () => result.resolve(fallback),
    run: async () => {
      started.resolve();
      return await result.promise;
    },
  };
}

async function drain(...runs: Promise<unknown>[]) {
  await Promise.allSettled(runs);
  await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
}

async function cleanup(
  state: CronServiceState,
  runs: (Promise<unknown> | undefined)[],
  gates: { release: () => void; promise: Promise<unknown> }[],
  slots?: { release: () => void; done: Promise<unknown> },
) {
  if (slots) {
    slots.release();
    await slots.done;
  }
  stop(state);
  for (const gate of gates) {
    gate.release();
  }
  await drain(
    ...runs.filter((run): run is Promise<unknown> => run !== undefined),
    ...gates.map((gate) => gate.promise),
  );
}

async function occupyWorkerSlots(state: CronServiceState, count: number) {
  const now = state.deps.nowMs();
  const jobs = Array.from({ length: count }, (_, index) => {
    const job = dueJob(`capacity-fixture-${index}`, now, now + 24 * 60 * 60_000);
    job.payload = { kind: "agentTurn", message: job.id, timeoutSeconds: 0 };
    return job;
  });
  const store = await loadCronStore(state.deps.storePath);
  await saveCronStore(state.deps.storePath, { ...store, jobs: [...store.jobs, ...jobs] });
  const ids = new Set(jobs.map((job) => job.id));
  const original = state.deps.runIsolatedAgentJob;
  const release = createDeferred();
  const started = createDeferred();
  let countStarted = 0;
  state.deps.runIsolatedAgentJob = async (params) => {
    if (!ids.has(params.job.id)) {
      return original(params);
    }
    params.onExecutionStarted?.();
    if (++countStarted === count) {
      started.resolve();
    }
    await release.promise;
    return { status: "ok" };
  };
  const done = Promise.all(jobs.map((job) => runManualCronJob(state, job.id, "force")));
  await awaitGateBeforeSettlement(
    started.promise,
    done,
    "Capacity fixture finished before its runs started",
  );
  return { release: () => release.resolve(), done };
}

function requireJob(state: { store?: { jobs?: CronJob[] } | null }, id: string): CronJob {
  const job = state.store?.jobs?.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`expected cron job ${id}`);
  }
  return job;
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

    const cronJob = announcingJob("oneshot-stale-delivery", scheduledAt, {
      kind: "at",
      at: new Date(scheduledAt).toISOString(),
    });
    cronJob.deleteAfterRun = true;
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
    const { state, storePath } = await setup([cronJob], firedAt, { runIsolatedAgentJob });

    await onTimer(state);

    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs).toHaveLength(1);
    const job = requireJob({ store: persisted }, cronJob.id);
    expect(job).toMatchObject({
      enabled: false,
      state: {
        lastStatus: "ok",
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: expect.stringContaining("skipping stale delivery"),
      },
    });
    expect(job.state.nextRunAtMs).toBeUndefined();

    // A fresh scheduler must retain the evidence without replaying completed work.
    stop(state);
    const restarted = createCronServiceState(state.deps);
    await onTimer(restarted);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect((await loadCronStore(storePath)).jobs).toEqual(persisted.jobs);
    stop(restarted);
  });

  it("enforces a minimum refire gap for second-granularity cron schedules (#17821)", async () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = announcingJob("spin-gap-17821", scheduledAt, {
      kind: "cron",
      expr: "* * * * * *",
      tz: "UTC",
    });
    let now = scheduledAt;
    const { state } = await setup([cronJob], () => now, {
      runIsolatedAgentJob: vi.fn(async () => {
        now += 100;
        return ok("done");
      }),
    });

    await onTimer(state);

    expect(requireJob(state, cronJob.id).state.nextRunAtMs).toBeGreaterThanOrEqual(now + 2_000);
    await onTimer(state);
    expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledOnce();
  });

  it("keeps conditioned main-session work cancellable until its execution settles", async () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = conditionJob(
      "main-session-cancel-boundary",
      scheduledAt,
      "queued downstream work",
    );
    let now = scheduledAt;
    const sessionResult = heldRunner({ status: "ok" as const });
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
      sessionResult.run,
    );
    const { state, storePath } = await setup([cronJob], () => now, {
      runSessionEvent,
      evaluateCronTrigger: async () => ({ kind: "evaluated", fire: true }),
    });

    const timerPromise = onTimer(state);
    try {
      await awaitGateBeforeSettlement(
        sessionResult.started,
        timerPromise,
        "Cron timer completed before main-session execution handoff",
      );
      expect(runSessionEvent).toHaveBeenCalledTimes(1);

      requestActiveCronJobCancellation(cronJob.id, "Cancelled by operator.");
      expect(inspectActiveCronRunReceipt({ storePath, jobId: cronJob.id })).toBeDefined();

      now = scheduledAt + 2_000;
      await timerPromise;
      sessionResult.resolve({ status: "ok" });
      await vi.advanceTimersByTimeAsync(0);

      expect(requireJob(state, cronJob.id).state).toMatchObject({
        lastStatus: "error",
        lastError: "Cancelled by operator.",
      });
      expect(runSessionEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "queued downstream work",
          job: expect.objectContaining({
            id: "main-session-cancel-boundary",
            sessionTarget: "main",
          }),
        }),
      );
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      await cleanup(state, [timerPromise], [sessionResult]);
      resetActiveCronTaskRunsForTests();
    }
  });

  it("allows cancellation of detached script work targeting the main session", async () => {
    resetActiveCronTaskRunsForTests();

    const scheduledAt = Date.parse("2026-07-18T12:00:00.000Z");
    const cronJob = scriptJob("main-script-cancel-boundary", scheduledAt, "done");
    const onAbort = vi.fn();
    let timerSettled = false;
    const runnerResult = heldRunner({
      status: "ok" as const,
      notify: "stale",
      wake: "now" as const,
    });
    const { state, storePath } = await setup([cronJob], scheduledAt, {
      cronConfig: { triggers: { enabled: true } },
      runScriptJob: vi.fn(async ({ abortSignal }) => {
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        // Deliberately ignore abort so the cron boundary must suppress any
        // late notify/wake result after operator cancellation has settled.
        return await runnerResult.run();
      }),
    });

    const timerPromise = onTimer(state).then(() => {
      timerSettled = true;
    });
    try {
      await runnerResult.started;

      const runId = requireAdmittedRunId(storePath, cronJob.id);
      requestActiveCronJobCancellation(cronJob.id, "Cancelled by operator.");
      expect(onAbort).toHaveBeenCalledOnce();

      await vi.waitFor(() => expect(timerSettled).toBe(true), { interval: 0 });
      await timerPromise;
      expect(
        readCronRunRecordsForTests(cronJob.id).find((entry) => entry.runId === runId)?.error,
      ).toBe("Cancelled by operator.");

      runnerResult.release();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      await cleanup(state, [timerPromise], [runnerResult]);
      resetActiveCronTaskRunsForTests();
    }
  });

  it("retires main-target script work across restart generation advance", async () => {
    resetActiveCronTaskRunsForTests();
    const scheduledAt = Date.parse("2026-07-18T12:05:00.000Z");
    const cronJob = scriptJob("main-script-generation-retire", scheduledAt, "stale");
    const release = heldRunner({ status: "ok" as const, notify: "stale" });
    const { state, storePath } = await setup([cronJob], scheduledAt, {
      cronConfig: { triggers: { enabled: true } },
      runScriptJob: vi.fn(release.run),
    });

    const timerPromise = onTimer(state);
    try {
      await release.started;
      expect(isCronJobActive(cronJob.id)).toBe(true);

      advanceCronActiveJobGeneration();
      expect(isCronJobActive(cronJob.id)).toBe(false);
      release.release();
      await timerPromise;

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]?.state.lastStatus).not.toBe("ok");
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      await cleanup(state, [timerPromise], [release]);
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

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("Gateway restarting"),
      });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      clearCronJobActive(cronJob.id, activeJobMarker);
    }
  });

  it("consumes a pending cancellation before a main condition binds its controller", async () => {
    const { storePath } = timerRegressionFixtures.makeStorePath();
    const now = Date.now();
    const cronJob = conditionJob("condition-cancel-before-bind", now, "must not enqueue");
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

  it("retries cron schedule computation from the next second when the first attempt returns undefined (#17821)", () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = announcingJob("retry-next-second-17821", scheduledAt, {
      kind: "cron",
      expr: "0 13 * * *",
      tz: "UTC",
    });

    const original = schedule.computeNextRunAtMs;
    const spy = vi.spyOn(schedule, "computeNextRunAtMs");
    spy.mockImplementationOnce(() => undefined).mockImplementation(original);
    const expected = original(cronJob.schedule, scheduledAt + 1_000);
    expect(expected).toBeDefined();
    expect(computeJobNextRunAtMs(cronJob, scheduledAt)).toBe(expected);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("preserves queued and running timestamps across clock jumps", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:01.250Z");
    const first = dueJob("scheduled-active", dueAt);
    const second = dueJob("scheduled-queued", dueAt);
    let now = dueAt;
    const releaseFirst = heldRunner(ok("first"));
    const releaseSecond = heldRunner(ok("second"));
    const clock = createGatewaySchedulerClock(dueAt);
    const { state, persistedJob } = await setup([first, second], () => now, {
      scheduler: createTestGatewayScheduler(clock.clock),
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: { id: string } }) => {
        return await (job.id === first.id ? releaseFirst : releaseSecond).run();
      }),
    });

    const slots = await occupyWorkerSlots(state, 7);
    const timerRun = onTimer(state);
    try {
      await awaitGateBeforeSettlement(
        releaseFirst.started,
        timerRun,
        "Scheduled requests finished before the first launch",
      );
      expect(requireJob(state, second.id).state.queuedAtMs).toBe(dueAt);
      now += 2 * 60 * 60 * 1000 + 1;
      await onTimer(state);
      expect(requireJob(state, second.id).state.queuedAtMs).toBe(dueAt);

      releaseFirst.release();
      await releaseSecond.started;
      const secondStartedAt = now;
      expect(requireJob(state, second.id).state.runningAtMs).toBe(secondStartedAt);
      expect((await persistedJob(second.id)).state.runningAtMs).toBe(secondStartedAt);
      now += 2 * 60 * 60 * 1000 + 1;
      await onTimer(state);
      expect(requireJob(state, second.id).state.runningAtMs).toBe(secondStartedAt);
      now += 100;
      releaseSecond.release();

      await timerRun;
      expect(requireJob(state, second.id).state).toMatchObject({
        lastRunAtMs: secondStartedAt,
        lastDurationMs: 2 * 60 * 60 * 1000 + 101,
      });
    } finally {
      await cleanup(state, [timerRun], [releaseFirst, releaseSecond], slots);
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
    const releaseActive = heldRunner(ok("manual"));
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      if (job.id === activeManualJob.id) {
        return await releaseActive.run();
      }
      return { status: "ok" as const, summary: "should not run" };
    });
    const { state, storePath, persistedJob } = await setup([activeManualJob, catchupJob], dueAt, {
      runIsolatedAgentJob,
    });

    const slots = await occupyWorkerSlots(state, 7);
    const activeRun = runManualCronJob(state, activeManualJob.id, "force");
    const queued = createDeferred();
    const stopObserving = observeCronJobCommits(catchupJob.id, ({ queuedAtMs }) => {
      if (queuedAtMs !== undefined) {
        queued.resolve();
      }
    });
    let catchupRun: ReturnType<typeof runMissedJobs> | undefined;
    try {
      await releaseActive.started;
      catchupRun = runMissedJobs(state);
      await queued.promise;
      await update(state, catchupJob.id, {
        schedule: { kind: "at", at: new Date(dueAt + 3_600_000).toISOString() },
      });

      releaseActive.release();
      await Promise.all([activeRun, catchupRun]);

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(requireJob(state, catchupJob.id).state.runningAtMs).toBeUndefined();
      expect((await persistedJob(catchupJob.id)).state.runningAtMs).toBeUndefined();
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(storePath), catchupJob.id) as { status: string } | undefined;
      expect(receipt?.status).toBe("skipped");
    } finally {
      stopObserving();
      await cleanup(state, [activeRun, catchupRun], [releaseActive], slots);
    }
  });

  it("does not start an admitted due job after stop wins its service-lock wait", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:01.500Z");
    const job = dueJob("stopped-due-service-lock", dueAt);
    const releaseServiceLock = createDeferred();
    const serviceLockHeld = createDeferred();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const { state } = await setup([job], dueAt, { runIsolatedAgentJob });
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
    const stalled = timedJob("setup-timeout-stalled", dueAt);
    const running = timedJob("setup-timeout-running-sibling", dueAt);
    const secondStalled = { ...stalled, id: "setup-timeout-second-stalled" };
    let now = dueAt;
    const allStarted = createDeferred();
    let startedCount = 0;
    const finishRunning = heldRunner(ok("finished"));
    const timeoutNotified = createDeferred();
    const onIsolatedAgentSetupTimeout = vi.fn(() => timeoutNotified.resolve());
    const runnerResult = heldRunner(ok("done"));
    const { state, storePath } = await setup([stalled, secondStalled, running], () => now, {
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job, onExecutionStarted }) => {
        if (++startedCount === 3) {
          allStarted.resolve();
        }
        if (job.id !== running.id) {
          return await runnerResult.promise;
        }
        onExecutionStarted?.({ jobId: job.id, phase: "model_call_started" });
        return await finishRunning.promise;
      }),
    });

    const timerPromise = onTimer(state);
    try {
      await allStarted.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await timeoutNotified.promise;

      const runningAtMsAfterRecovery = requireJob(state, running.id).state.runningAtMs;
      const receiptHeldAfterRecovery =
        inspectActiveCronRunReceipt({ storePath, jobId: running.id }) !== undefined;
      finishRunning.release();
      await timerPromise;

      expect(runningAtMsAfterRecovery).toBe(dueAt);
      expect(receiptHeldAfterRecovery).toBe(true);
      expect(requireJob(state, running.id).state.lastStatus).toBe("ok");
      expect(requireJob(state, stalled.id).state.lastStatus).toBe("error");
      expect(requireJob(state, secondStalled.id).state.lastStatus).toBe("error");
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledExactlyOnceWith({
        job: expect.objectContaining({ id: expect.stringMatching(/^setup-timeout-.*stalled$/) }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
    } finally {
      await cleanup(state, [timerPromise], [runnerResult, finishRunning]);
    }
  });

  it("notifies timeout recovery before admitting queued manual work", async () => {
    const dueAt = Date.parse("2026-02-06T10:06:31.000Z");
    const first = timedJob("serial-timeout-recovery-first", dueAt);
    const second = timedJob("serial-timeout-recovery-second", dueAt, dueAt + 3_600_000);
    let now = dueAt;
    const secondStarted = createDeferred();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = heldRunner(ok("done"));
    const { state } = await setup([first, second], () => now, {
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: CronJob }) => {
        if (job.id === first.id) {
          return await runnerResult.run();
        }
        expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledOnce();
        secondStarted.resolve();
        return ok("second after recovery");
      }),
    });

    const slots = await occupyWorkerSlots(state, 7);
    const timerPromise = onTimer(state);
    let manualRun: ReturnType<typeof runManualCronJob> | undefined;
    try {
      await runnerResult.started;
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
      await cleanup(state, [timerPromise, manualRun], [runnerResult], slots);
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
    const releaseRun = heldRunner(ok("old service result"));
    const { state, storePath } = await setup(
      [job, unstartedJob, replacementClaimedJob],
      scheduledAt,
      {
        maxMissedJobsPerRestart: 1,
        runIsolatedAgentJob: releaseRun.run,
      },
    );

    const missedJobs = runMissedJobs(state);
    try {
      await releaseRun.started;

      state.stopped = true;
      const replacementReservationMs = scheduledAt + 123;
      const replacementStore = await loadCronStore(storePath);
      const replacementPersistedJob = requireJob(
        { store: replacementStore },
        replacementClaimedJob.id,
      );
      replacementPersistedJob.state.queuedAtMs = replacementReservationMs;
      await saveCronStore(storePath, replacementStore);

      releaseRun.release();
      await missedJobs;

      const persisted = { store: await loadCronStore(storePath) };
      const completed = requireJob(persisted, job.id).state;
      const unstarted = requireJob(persisted, unstartedJob.id).state;
      const replacement = requireJob(persisted, replacementClaimedJob.id).state;
      expect(completed.runningAtMs).toBeUndefined();
      expect(completed.lastStatus).toBe("ok");
      expect(unstarted.runningAtMs).toBeUndefined();
      expect(unstarted.lastStatus).toBeUndefined();
      expect(replacement.queuedAtMs).toBe(replacementReservationMs);
      expect(replacement.lastStatus).toBeUndefined();
      expect(readCronRunRecordsForTests().find((entry) => entry.jobId === job.id)?.status).toBe(
        "succeeded",
      );
    } finally {
      await cleanup(state, [missedJobs], [releaseRun]);
    }
  });

  it("starts the scheduled batch after manual setup-timeout notification", async () => {
    const scheduledAt = Date.parse("2026-05-10T08:59:00.000Z");
    const manualJob = timedJob(
      "manual-setup-timeout-active-batch",
      scheduledAt,
      scheduledAt + 3_600_000,
    );
    const firstScheduledJob = dueJob("scheduled-before-manual-recovery", scheduledAt);
    const secondScheduledJob = dueJob("scheduled-blocked-by-manual-recovery", scheduledAt);
    vi.setSystemTime(scheduledAt);
    let now = scheduledAt;
    const finishFirstScheduled = heldRunner(ok("first scheduled"));
    const secondScheduledStarted = vi.fn();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const runnerResult = heldRunner(ok("done"));
    const clock = createGatewaySchedulerClock(scheduledAt);
    const { state } = await setup([manualJob, firstScheduledJob, secondScheduledJob], () => now, {
      scheduler: createTestGatewayScheduler(clock.clock),
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ job, onExecutionStarted }) => {
        if (job.id === manualJob.id) {
          return await runnerResult.run();
        }
        if (job.id === firstScheduledJob.id) {
          onExecutionStarted?.();
          return await finishFirstScheduled.run();
        }
        secondScheduledStarted(job.id);
        return ok("second scheduled");
      }),
    });

    const slots = await occupyWorkerSlots(state, 7);
    const manualRun = runManualCronJob(state, manualJob.id, "force");
    let timerRun: ReturnType<typeof onTimer> | undefined;
    try {
      await runnerResult.started;
      timerRun = onTimer(state);

      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await manualRun;
      await finishFirstScheduled.started;

      finishFirstScheduled.release();
      await timerRun;
      expect(secondScheduledStarted).toHaveBeenCalledWith(secondScheduledJob.id);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      const second = requireJob(state, secondScheduledJob.id);
      expect(second.state.lastStatus).toBe("ok");
      expect(second.state.runningAtMs).toBeUndefined();
    } finally {
      await cleanup(state, [manualRun, timerRun], [runnerResult, finishFirstScheduled], slots);
    }
  });

  it("finalizes a removed job's ok outcome in operator history", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const job = dueJob("self-removing-ok", dueAt);
    job.delivery = { mode: "announce", channel: "telegram", to: "chat-123" };
    const events: CronEvent[] = [];
    const summary = `finished ${job.id}`;
    const { state, storePath } = await setup([job], dueAt, {
      onEvent: (event) => {
        events.push(event);
      },
      runIsolatedAgentJob: vi.fn(async () => {
        const persisted = await loadCronStore(storePath);
        await saveCronStore(storePath, {
          ...persisted,
          jobs: persisted.jobs.filter((entry) => entry.id !== job.id),
        });
        return { status: "ok" as const, error: undefined, summary, delivered: true };
      }),
    });
    await onTimer(state);
    expect(state.store?.jobs).toStrictEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        jobId: job.id,
        action: "finished",
        status: "ok",
        error: undefined,
        summary,
        delivered: true,
        deliveryStatus: "delivered",
      }),
    );
    expect(
      readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id }).entries,
    ).toEqual([expect.objectContaining({ jobId: job.id, status: "ok", error: undefined })]);
    expect(readCronRunRecordsForTests().find((record) => record.jobId === job.id)?.status).toBe(
      "succeeded",
    );
  });
});
