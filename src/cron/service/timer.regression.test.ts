import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const fixtures = setupCronRegressionFixtures({ prefix: "cron-service-timer-regressions-" });
const AT = Date.parse("2026-02-15T13:00:00.000Z");
const HOUR = 3_600_000;
const CANCELLED = "Cancelled by operator.";
const ok = (summary = "done") => ({ status: "ok" as const, summary });
const states: CronServiceState[] = [];
const tasks: Promise<unknown>[] = [];
const gates: { release: () => void; promise: Promise<unknown> }[] = [];
const slots: { release: () => void; done: Promise<unknown> }[] = [];
const releases: (() => void)[] = [];
let now = AT;

function track<T>(task: Promise<T>): Promise<T> {
  tasks.push(task);
  return task;
}
const tick = (state: CronServiceState) => track(onTimer(state));
const catchup = (state: CronServiceState) => track(runMissedJobs(state));
const manual = (state: CronServiceState, id: string) => track(runManualCronJob(state, id, "force"));
const dueJob = (id: string, nextRunAtMs = AT) =>
  createDueIsolatedJob({ id, nowMs: AT, nextRunAtMs });
const timedJob = (id: string, nextRunAtMs = AT): CronJob => ({
  ...dueJob(id, nextRunAtMs),
  payload: { kind: "agentTurn", message: id, timeoutSeconds: 120 },
});
function mainJob(id: string, payload: CronJob["payload"]): CronJob {
  const job = dueJob(id);
  delete job.delivery;
  return { ...job, sessionTarget: "main", wakeMode: "now", payload };
}
const conditionJob = () => ({
  ...mainJob("main-cancel", { kind: "systemEvent", text: "queued downstream work" }),
  schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: AT - 60_000 },
  trigger: { script: "json({ fire: true })" },
});
function jobIn(jobs: CronJob[] | undefined, id: string) {
  const job = jobs?.find((candidate) => candidate.id === id);
  return expectDefined(job, "cron job " + id);
}
const jobState = (state: CronServiceState, id: string) => jobIn(state.store?.jobs, id).state;
async function setup(jobs: CronJob[], deps: Partial<CronServiceDeps> = {}) {
  const { storePath } = fixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs });
  const state = createCronServiceState({
    storePath,
    nowMs: () => now,
    runIsolatedAgentJob: createDefaultIsolatedRunner(),
    ...deps,
  });
  states.push(state);
  return {
    state,
    storePath,
    stored: async (id: string) => jobIn((await loadCronStore(storePath)).jobs, id).state,
  };
}
function heldRunner<T>(fallback: T) {
  const started = createDeferred();
  const result = createDeferred<T>();
  const gate = {
    ...result,
    started: started.promise,
    release: () => result.resolve(fallback),
    run: vi.fn(async () => {
      started.resolve();
      return await result.promise;
    }),
  };
  gates.push(gate);
  return gate;
}
async function advance(ms = 60_100) {
  await vi.advanceTimersByTimeAsync(ms);
  now += ms;
}
async function occupyWorkerSlots(state: CronServiceState) {
  const jobs = Array.from({ length: 7 }, (_, index) => {
    const job = dueJob("capacity-" + index, now + 24 * HOUR);
    job.payload = { kind: "agentTurn", message: job.id, timeoutSeconds: 0 };
    return job;
  });
  const store = await loadCronStore(state.deps.storePath);
  await saveCronStore(state.deps.storePath, { ...store, jobs: [...store.jobs, ...jobs] });
  const ids = new Set(jobs.map((job) => job.id));
  const original = state.deps.runIsolatedAgentJob;
  const release = createDeferred();
  const started = createDeferred();
  let count = 0;
  state.deps.runIsolatedAgentJob = async (params) => {
    if (!ids.has(params.job.id)) {
      return original(params);
    }
    params.onExecutionStarted?.();
    if (++count === jobs.length) {
      started.resolve();
    }
    await release.promise;
    return { status: "ok" };
  };
  const done = Promise.all(jobs.map((job) => manual(state, job.id)));
  slots.push({ release: () => release.resolve(), done });
  await awaitGateBeforeSettlement(started.promise, done, "Capacity fixture finished before start");
}

describe("cron service timer regressions", () => {
  beforeEach(() => {
    now = AT;
    resetActiveCronTaskRunsForTests();
  });
  // Drain occupied slots before stopping services, then release abort-ignoring cores.
  // This nested hook precedes the shared fixture's timer and store cleanup.
  afterEach(async () => {
    for (const slot of slots.splice(0)) {
      slot.release();
      await slot.done;
    }
    states.splice(0).forEach(stop);
    releases.splice(0).forEach((release) => release());
    const held = gates.splice(0);
    held.forEach((gate) => gate.release());
    await Promise.allSettled([...tasks.splice(0), ...held.map((gate) => gate.promise)]);
    await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    resetActiveCronTaskRunsForTests();
  });

  it("#131491: retains a deleteAfterRun one-shot whose stale guard suppressed its delivery", async () => {
    const job = {
      ...dueJob("stale-delivery"),
      deleteAfterRun: true,
      delivery: { mode: "announce" as const },
    };
    now += 18 * HOUR;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      ...ok("report finished"),
      delivered: false,
      deliveryAttempted: true,
      deliveryState: {
        delivered: false,
        status: "not-delivered",
        error: "skipping stale delivery scheduled at 2026-02-06T10:00:00.000Z, started 1080m late",
        failureNotification: { status: "not-requested" },
      },
    });
    const { state, storePath } = await setup([job], { runIsolatedAgentJob });
    await tick(state);
    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs).toHaveLength(1);
    expect(jobIn(persisted.jobs, job.id)).toMatchObject({
      enabled: false,
      state: {
        lastStatus: "ok",
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: expect.stringContaining("skipping stale delivery"),
      },
    });
    expect(jobIn(persisted.jobs, job.id).state.nextRunAtMs).toBeUndefined();
    stop(state);
    const restarted = createCronServiceState(state.deps);
    await tick(restarted);
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
    expect((await loadCronStore(storePath)).jobs).toEqual(persisted.jobs);
  });

  it("enforces a minimum refire gap for second-granularity cron schedules (#17821)", async () => {
    const job: CronJob = {
      ...dueJob("spin-gap"),
      delivery: { mode: "announce" },
      schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC" },
    };
    const { state } = await setup([job], {
      runIsolatedAgentJob: vi.fn(async () => {
        now += 100;
        return ok();
      }),
    });
    await tick(state);
    expect(jobState(state, job.id).nextRunAtMs).toBeGreaterThanOrEqual(now + 2_000);
    await tick(state);
    expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledOnce();
  });

  it("keeps conditioned main-session work cancellable until its execution settles", async () => {
    const job = conditionJob();
    const runner = heldRunner({ status: "ok" as const });
    const { state, storePath } = await setup([job], {
      runSessionEvent: runner.run,
      evaluateCronTrigger: async () => ({ kind: "evaluated", fire: true }),
    });
    const running = tick(state);
    await awaitGateBeforeSettlement(runner.started, running, "Early session completion");
    requestActiveCronJobCancellation(job.id, CANCELLED);
    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeDefined();
    now += 2_000;
    await running;
    runner.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobState(state, job.id)).toMatchObject({ lastStatus: "error", lastError: CANCELLED });
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it.each(["operator cancellation", "restart generation"] as const)(
    "suppresses late main-target script output after %s",
    async (reason) => {
      const job = mainJob("script", { kind: "script", script: "return {}", timeoutSeconds: 0 });
      const runner = heldRunner({ status: "ok" as const, notify: "stale", wake: "now" as const });
      const onAbort = vi.fn();
      const { state, storePath, stored } = await setup([job], {
        cronConfig: { triggers: { enabled: true } },
        runScriptJob: async ({ abortSignal }) => {
          abortSignal?.addEventListener("abort", onAbort, { once: true });
          return await runner.run(); // Ignore abort to exercise late-output suppression.
        },
      });
      const running = tick(state);
      await runner.started;
      if (reason === "operator cancellation") {
        const receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
        if (!receipt) {
          throw new Error("Expected an admitted cron receipt");
        }
        const runId = "cron:" + job.id + ":" + receipt.startedAtMs + ":" + receipt.receiptId;
        requestActiveCronJobCancellation(job.id, CANCELLED);
        expect(onAbort).toHaveBeenCalledOnce();
        await awaitGateBeforeSettlement(running, runner.promise, "Cancellation waited for core");
        expect(
          readCronRunRecordsForTests(job.id).find((entry) => entry.runId === runId)?.error,
        ).toBe(CANCELLED);
      } else {
        expect(isCronJobActive(job.id)).toBe(true);
        advanceCronActiveJobGeneration();
        expect(isCronJobActive(job.id)).toBe(false);
      }
      runner.release();
      await running;
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      if (reason === "restart generation") {
        expect((await stored(job.id)).lastStatus).not.toBe("ok");
      }
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["retired generation", "pending cancellation"] as const)(
    "rejects runner admission before controller binding for %s",
    async (reason) => {
      const job = reason === "retired generation" ? dueJob("retired") : conditionJob();
      const marker = markCronJobActive(job.id);
      releases.push(() => clearCronJobActive(job.id, marker));
      if (reason === "retired generation") {
        advanceCronActiveJobGeneration();
      } else {
        requestActiveCronJobCancellation(job.id, "Cron job disabled by operator.");
      }
      const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
      const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
      const { state } = await setup([], { evaluateCronTrigger, runSessionEvent });
      await expect(
        executeJobCoreWithTimeout(state, job, { activeJobMarker: marker }),
      ).resolves.toMatchObject({
        status: "error",
        error:
          reason === "retired generation"
            ? expect.stringContaining("Gateway restarting")
            : "Cron job disabled by operator.",
      });
      expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      expect(runSessionEvent).not.toHaveBeenCalled();
    },
  );

  it("retries cron schedule computation from the next second when the first attempt returns undefined (#17821)", () => {
    const job: CronJob = {
      ...dueJob("retry"),
      schedule: { kind: "cron", expr: "0 13 * * *", tz: "UTC" },
    };
    vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValueOnce(undefined);
    expect(computeJobNextRunAtMs(job, AT)).toBe(AT + 24 * HOUR);
  });

  it("preserves queued and running timestamps across clock jumps", async () => {
    const first = dueJob("scheduled-active");
    const second = dueJob("scheduled-queued");
    const releaseFirst = heldRunner(ok("first"));
    const releaseSecond = heldRunner(ok("second"));
    const { state, stored } = await setup([first, second], {
      scheduler: createTestGatewayScheduler(createGatewaySchedulerClock(AT).clock),
      runIsolatedAgentJob: async ({ job }) =>
        await (job.id === first.id ? releaseFirst : releaseSecond).run(),
    });
    await occupyWorkerSlots(state);
    const running = tick(state);
    await awaitGateBeforeSettlement(releaseFirst.started, running, "Early batch completion");
    expect(jobState(state, second.id).queuedAtMs).toBe(AT);
    now += 2 * HOUR + 1;
    await tick(state);
    expect(jobState(state, second.id).queuedAtMs).toBe(AT);
    releaseFirst.release();
    await releaseSecond.started;
    const startedAt = now;
    expect(jobState(state, second.id).runningAtMs).toBe(startedAt);
    expect((await stored(second.id)).runningAtMs).toBe(startedAt);
    now += 2 * HOUR + 1;
    await tick(state);
    expect(jobState(state, second.id).runningAtMs).toBe(startedAt);
    now += 100;
    releaseSecond.release();
    await running;
    expect(jobState(state, second.id)).toMatchObject({
      lastRunAtMs: startedAt,
      lastDurationMs: 2 * HOUR + 101,
    });
  });

  it("rechecks startup catch-up eligibility after an admission wait", async () => {
    const first = dueJob("manual-before-catchup", AT + HOUR);
    const second = dueJob("rescheduled-startup-catchup");
    const runner = heldRunner(ok());
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) =>
      job.id === first.id ? await runner.run() : ok("should not run"),
    );
    const { state, storePath, stored } = await setup([first, second], { runIsolatedAgentJob });
    await occupyWorkerSlots(state);
    const active = manual(state, first.id);
    const queued = createDeferred();
    releases.push(
      observeCronJobCommits(second.id, ({ queuedAtMs }) => {
        if (queuedAtMs !== undefined) {
          queued.resolve();
        }
      }),
    );
    await runner.started;
    const missed = catchup(state);
    await queued.promise;
    await update(state, second.id, {
      schedule: { kind: "at", at: new Date(AT + HOUR).toISOString() },
    });
    runner.release();
    await Promise.all([active, missed]);
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
    expect(jobState(state, second.id).runningAtMs).toBeUndefined();
    expect((await stored(second.id)).runningAtMs).toBeUndefined();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
      )
      .get(cronStoreKey(storePath), second.id);
    expect(receipt).toMatchObject({ status: "skipped" });
  });

  it("does not start an admitted due job after stop wins its service-lock wait", async () => {
    const release = heldRunner(undefined);
    const locked = createDeferred();
    const runIsolatedAgentJob = vi.fn(async () => ok());
    const { state } = await setup([dueJob("stopped")], { runIsolatedAgentJob });
    let operation = state.op;
    let holdNext = true;
    Object.defineProperty(state, "op", {
      configurable: true,
      get: () => operation,
      set: (next: Promise<unknown>) => {
        if (holdNext) {
          holdNext = false;
          operation = release.promise;
          locked.resolve();
        } else {
          operation = next;
        }
      },
    });
    const running = tick(state);
    await locked.promise;
    stop(state);
    release.release();
    await running;
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it.each(["stalled batch", "queued manual", "scheduled batch"] as const)(
    "settles timeout recovery before releasing the %s",
    async (mode) => {
      const parallel = mode === "stalled batch";
      const scheduled = mode === "scheduled batch";
      if (scheduled) {
        vi.setSystemTime(AT);
      }
      const stalled = timedJob("stalled", scheduled ? AT + HOUR : AT);
      const next = scheduled ? dueJob("first") : timedJob("next", parallel ? AT : AT + HOUR);
      const last = parallel ? timedJob("second-stalled") : dueJob("second");
      const stalledRunner = heldRunner(ok());
      const nextRunner = heldRunner(ok());
      const allStarted = createDeferred();
      const notified = createDeferred();
      const notice = vi.fn(() => notified.resolve());
      let count = 0;
      const { state, storePath } = await setup(
        parallel ? [stalled, last, next] : scheduled ? [stalled, next, last] : [stalled, next],
        {
          ...(scheduled
            ? { scheduler: createTestGatewayScheduler(createGatewaySchedulerClock(AT).clock) }
            : {}),
          onIsolatedAgentSetupTimeout: notice,
          runIsolatedAgentJob: async ({ job, onExecutionStarted }) => {
            if (parallel) {
              if (++count === 3) {
                allStarted.resolve();
              }
              if (job.id !== next.id) {
                return await stalledRunner.promise;
              }
              onExecutionStarted?.({ jobId: job.id, phase: "model_call_started" });
            } else {
              if (job.id === stalled.id) {
                return await stalledRunner.run();
              }
              expect(notice).toHaveBeenCalledOnce();
              if (job.id === last.id) {
                return ok();
              }
              if (scheduled) {
                onExecutionStarted?.();
              }
            }
            return await nextRunner.run();
          },
        },
      );
      if (!parallel) {
        await occupyWorkerSlots(state);
      }
      const active = scheduled ? manual(state, stalled.id) : tick(state);
      await (parallel ? allStarted.promise : stalledRunner.started);
      const queued = parallel ? undefined : scheduled ? tick(state) : manual(state, next.id);
      await advance();
      await notified.promise;
      if (parallel) {
        expect(jobState(state, next.id).runningAtMs).toBe(AT);
        expect(inspectActiveCronRunReceipt({ storePath, jobId: next.id })).toBeDefined();
      } else {
        await active;
        await nextRunner.started;
      }
      nextRunner.release();
      await Promise.all([active, queued]);
      expect(notice).toHaveBeenCalledOnce();
      expect(jobState(state, stalled.id).lastStatus).toBe("error");
      expect(jobState(state, next.id).lastStatus).toBe("ok");
      if (parallel) {
        expect(jobState(state, last.id).lastStatus).toBe("error");
        expect(notice).toHaveBeenCalledWith(
          expect.objectContaining({
            job: expect.objectContaining({ id: expect.stringMatching(/stalled$/) }),
          }),
        );
      } else if (scheduled) {
        expect(jobState(state, last.id).lastStatus).toBe("ok");
        expect(jobState(state, last.id).runningAtMs).toBeUndefined();
      }
    },
  );

  it("recovers stopped catch-up outcomes without overwriting replacement reservations", async () => {
    const job = dueJob("stopped-startup-catchup");
    const unstarted = dueJob("unstarted-stopped-startup-catchup");
    const replacement = dueJob("replacement-claimed-catchup");
    const runner = heldRunner(ok("old service result"));
    const { state, storePath } = await setup([job, unstarted, replacement], {
      maxMissedJobsPerRestart: 1,
      runIsolatedAgentJob: runner.run,
    });
    const missed = catchup(state);
    await runner.started;
    state.stopped = true;
    const replacementStore = await loadCronStore(storePath);
    jobIn(replacementStore.jobs, replacement.id).state.queuedAtMs = AT + 123;
    await saveCronStore(storePath, replacementStore);
    runner.release();
    await missed;
    const persisted = (await loadCronStore(storePath)).jobs;
    const [completedState, unstartedState, replacementState] = [job, unstarted, replacement].map(
      ({ id }) => jobIn(persisted, id).state,
    );
    expect(completedState?.runningAtMs).toBeUndefined();
    expect(completedState?.lastStatus).toBe("ok");
    expect(unstartedState?.runningAtMs).toBeUndefined();
    expect(unstartedState?.lastStatus).toBeUndefined();
    expect(replacementState?.queuedAtMs).toBe(AT + 123);
    expect(replacementState?.lastStatus).toBeUndefined();
    expect(readCronRunRecordsForTests(job.id)).toMatchObject([{ status: "succeeded" }]);
  });

  it("finalizes a removed job's ok outcome in operator history", async () => {
    const job = dueJob("removed");
    job.delivery = { mode: "announce", channel: "telegram", to: "chat-123" };
    const events: CronEvent[] = [];
    const { state, storePath } = await setup([job], {
      onEvent: (event) => events.push(event),
      runIsolatedAgentJob: async () => {
        await saveCronStore(storePath, { version: 1, jobs: [] });
        return { ...ok(), error: undefined, delivered: true };
      },
    });
    await tick(state);
    expect(state.store?.jobs).toStrictEqual([]);
    expect(events.filter((event) => event.action === "finished")).toMatchObject([
      {
        jobId: job.id,
        status: "ok",
        error: undefined,
        summary: "done",
        delivered: true,
        deliveryStatus: "delivered",
      },
    ]);
    expect(
      readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id }).entries,
    ).toEqual([expect.objectContaining({ jobId: job.id, status: "ok", error: undefined })]);
    expect(readCronRunRecordsForTests(job.id)).toMatchObject([{ status: "succeeded" }]);
  });
});
