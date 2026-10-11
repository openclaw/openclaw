import { describe, expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState as createCronServiceState,
  createDefaultIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeatAndWait as requestOwnedHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatRunResult,
} from "../../infra/heartbeat-wake.js";
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
import { computeJobNextRunAtMs } from "./jobs-scheduling.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { run as runManualCronJob } from "./ops-run.js";
import type { CronEvent, CronServiceDeps, CronServiceState } from "./state.js";
import { executeJobCoreWithTimeout, runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const timerRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timer-regressions-",
});

function dueJob(id: string, nowMs: number, nextRunAtMs = nowMs) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs });
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

async function storeJobs(jobs: CronJob[]) {
  const { storePath } = timerRegressionFixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs });
  return storePath;
}

async function drain(...runs: Promise<unknown>[]) {
  await Promise.allSettled(runs);
  await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
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
    if (!ids.has(params.job.id)) return original(params);
    params.onExecutionStarted?.();
    if (++countStarted === count) started.resolve();
    await release.promise;
    return { status: "ok" };
  };
  const done = Promise.all(jobs.map((job) => runManualCronJob(state, job.id, "force")));
  await started.promise;
  return { release: () => release.resolve(), done };
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

  it("keeps job cancellation from retracting a conditioned main payload after handoff", async () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = mainJob("main-session-cancel-boundary", scheduledAt, {
      kind: "systemEvent",
      text: "queued downstream work",
    });
    cronJob.schedule = { kind: "every", everyMs: 60_000, anchorMs: scheduledAt - 60_000 };
    cronJob.trigger = { script: "json({ fire: true })" };
    const storePath = await storeJobs([cronJob]);

    let now = scheduledAt;
    const heartbeatStarted = createDeferred();
    const heartbeatResult = createDeferred<HeartbeatRunResult>();
    const requestHeartbeatAndWait = vi.fn(async (): Promise<HeartbeatRunResult> => {
      heartbeatStarted.resolve();
      return await heartbeatResult.promise;
    });
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const state = createCronServiceState({
      storePath,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      requestHeartbeatAndWait,
      evaluateCronTrigger: async () => ({ kind: "evaluated", fire: true }),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    const timerPromise = onTimer(state);
    try {
      await Promise.race([
        heartbeatStarted.promise,
        timerPromise.then(() => {
          throw new Error("Cron timer completed before main-session heartbeat handoff");
        }),
      ]);
      expect(requestHeartbeatAndWait).toHaveBeenCalledTimes(1);

      requestActiveCronJobCancellation(cronJob.id, "Cancelled by operator.");
      expect(inspectActiveCronRunReceipt({ storePath, jobId: cronJob.id })).toBeDefined();

      now = scheduledAt + 2_000;
      heartbeatResult.resolve({ status: "ran", durationMs: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await timerPromise;

      expect(requireJob(state, cronJob.id).state.lastStatus).toBe("ok");
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "queued downstream work",
        expect.objectContaining({
          agentId: "main",
          contextKey: "cron:main-session-cancel-boundary",
        }),
      );
      expect(enqueueSystemEvent.mock.calls[0]?.[1]).not.toHaveProperty("sessionKey");
      expect(requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      stop(state);
      heartbeatResult.resolve({ status: "ran", durationMs: 0 });
      await drain(timerPromise, heartbeatResult.promise);
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
    const requestHeartbeat = vi.fn();
    const state = createCronServiceState({
      cronConfig: { triggers: { enabled: true } },
      storePath,
      nowMs: () => scheduledAt,
      enqueueSystemEvent,
      requestHeartbeat,
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
      expect(requestHeartbeat).not.toHaveBeenCalled();
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
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
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
    cronJob.payload = { kind: "systemEvent", text: "must not enqueue" };
    cronJob.schedule = { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 };
    cronJob.trigger = { script: "json({ fire: true })" };
    const activeJobMarker = markCronJobActive(cronJob.id);
    requestActiveCronJobCancellation(cronJob.id, "Cron job disabled by operator.");
    const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
    const enqueueSystemEvent = vi.fn();
    const state = createCronServiceState({
      storePath,
      enqueueSystemEvent,
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
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      clearCronJobActive(cronJob.id, activeJobMarker);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
  });

  it("retries recurring wake-now main jobs until temporary lane pressure clears (#75964)", async () => {
    const { storePath } = timerRegressionFixtures.makeStorePath();
    const nowMs = () => Date.now();
    const runHeartbeat = vi
      .fn<() => Promise<HeartbeatRunResult>>()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 12 });
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const job: CronJob = {
      id: "busy-recurring-main",
      name: "busy recurring main",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "*/3 * * * *", tz: "UTC", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: 1 },
    };
    const state = createCronServiceState({
      storePath,
      nowMs,
      enqueueSystemEvent,
      requestHeartbeat,
      requestHeartbeatAndWait: (wake, lifecycle) =>
        requestOwnedHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    state.store = { version: 1, jobs: [job] };
    await saveCronStore(storePath, { version: 1, jobs: [job] });

    const disposeWake = setHeartbeatWakeHandler(runHeartbeat);
    const runPromise = runMissedJobs(state);
    try {
      await vi.waitFor(() => expect(runHeartbeat).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await runPromise;
    } finally {
      disposeWake();
    }

    const persistedJob = (await loadCronStore(storePath)).jobs.find(
      (candidate) => candidate.id === job.id,
    );
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(runHeartbeat).toHaveBeenCalledTimes(2);
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(persistedJob?.state.lastStatus).toBe("ok");
    expect(persistedJob?.state.runningAtMs).toBeUndefined();
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

  it("preserves queued and running timestamps across clock jumps", async () => {
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
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath,
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

    const slots = await occupyWorkerSlots(state, 7);
    const timerRun = onTimer(state);
    try {
      await firstStarted.promise;
      expect(requireJob(state, second.id).state.queuedAtMs).toBe(dueAt);
      now += 2 * 60 * 60 * 1000 + 1;
      await onTimer(state);
      expect(requireJob(state, second.id).state.queuedAtMs).toBe(dueAt);

      releaseFirst.resolve({ status: "ok", summary: "first" });
      await secondStarted.promise;
      const secondStartedAt = now;
      expect(requireJob(state, second.id).state.runningAtMs).toBe(secondStartedAt);
      expect(
        (await loadCronStore(storePath))?.jobs.find((job) => job.id === second.id)?.state
          .runningAtMs,
      ).toBe(secondStartedAt);
      now += 2 * 60 * 60 * 1000 + 1;
      await onTimer(state);
      expect(requireJob(state, second.id).state.runningAtMs).toBe(secondStartedAt);
      now += 100;
      releaseSecond.resolve({ status: "ok", summary: "second" });

      await timerRun;
      const completedSecond = state.store?.jobs.find((job) => job.id === second.id);
      expect(completedSecond?.state.lastRunAtMs).toBe(secondStartedAt);
      expect(completedSecond?.state.lastDurationMs).toBe(2 * 60 * 60 * 1000 + 101);
    } finally {
      slots.release();
      await slots.done;
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
      nowMs: () => dueAt,
      runIsolatedAgentJob,
    });

    const slots = await occupyWorkerSlots(state, 7);
    const activeRun = runManualCronJob(state, activeManualJob.id, "force");
    const queued = createDeferred();
    const stopObserving = observeCronJobCommits(catchupJob.id, ({ queuedAtMs }) => {
      if (queuedAtMs !== undefined) queued.resolve();
    });
    let catchupRun: ReturnType<typeof runMissedJobs> | undefined;
    try {
      await activeStarted.promise;
      catchupRun = runMissedJobs(state);
      await queued.promise;
      await update(state, catchupJob.id, {
        schedule: { kind: "at", at: new Date(dueAt + 3_600_000).toISOString() },
      });

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
      stopObserving();
      slots.release();
      await slots.done;
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
      const receiptHeldAfterRecovery =
        inspectActiveCronRunReceipt({ storePath, jobId: running.id }) !== undefined;
      finishRunning.resolve({ status: "ok", summary: "finished" });
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

    const slots = await occupyWorkerSlots(state, 7);
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
      slots.release();
      await slots.done;
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

    const slots = await occupyWorkerSlots(state, 7);
    const manualRun = runManualCronJob(state, manualJob.id, "force");
    let timerRun: ReturnType<typeof onTimer> | undefined;
    try {
      await manualStarted.promise;
      timerRun = onTimer(state);

      await vi.advanceTimersByTimeAsync(60_100);
      now += 60_100;
      await manualRun;
      await firstScheduledStarted.promise;

      finishFirstScheduled.resolve();
      await timerRun;
      expect(secondScheduledStarted).toHaveBeenCalledWith(secondScheduledJob.id);
      expect(requireJob(state, secondScheduledJob.id).state.lastStatus).toBe("ok");

      const second = requireJob(state, secondScheduledJob.id);
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledTimes(1);
      expect(second.state.runningAtMs).toBeUndefined();
    } finally {
      slots.release();
      await slots.done;
      stop(state);
      runnerResult.resolve({ status: "ok", summary: "done" });
      finishFirstScheduled.resolve();
      await drain(
        manualRun,
        ...(timerRun ? [timerRun] : []),
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
