import { describe, expect, it, vi } from "vitest";
import { observeCronStoreCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import * as activeJobs from "../active-jobs.js";
import { isCronJobActive, markCronJobActive } from "../active-jobs.js";
import {
  readCronRunHistoryPageForTests,
  readCronRunRecordsForTests,
} from "../run-history.test-support.js";
import { createCronExecutionId } from "../run-id.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import { add, remove } from "./ops-mutations.js";
import * as runtimeMutation from "./runtime-mutation.js";
import type { CronEvent, CronServiceDeps, CronServiceState } from "./state.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { authorCronRunCompletion, runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-service-batch-finalization-" });
const DUE_AT = Date.parse("2026-02-06T10:05:00.250Z");
type BatchTrigger = "scheduled" | "startup";

function dueJob(id: string, overrides?: Partial<CronJob>): CronJob {
  return { ...createDueIsolatedJob({ id, nowMs: DUE_AT, nextRunAtMs: DUE_AT }), ...overrides };
}

async function fixture(
  jobs: CronJob[],
  deps: Partial<Parameters<typeof createCronRegressionState>[0]> = {},
) {
  const { storePath } = fixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs });
  const state = createCronRegressionState({
    storePath,
    nowMs: () => DUE_AT,
    runIsolatedAgentJob: vi.fn(),
    maxMissedJobsPerRestart: 40,
    ...deps,
  });
  return { state, storePath };
}

function blockedRunner(blockedId?: string) {
  const started = createDeferred();
  const release = createDeferred<{ status: "ok"; summary: string }>();
  const run = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async ({ job }) => {
    if (blockedId && job.id !== blockedId) {
      return { status: "ok", summary: "first completion" };
    }
    started.resolve();
    return await release.promise;
  });
  return { started, release, run };
}

function startBatch(trigger: BatchTrigger, state: CronServiceState) {
  return trigger === "scheduled" ? onTimer(state) : runMissedJobs(state);
}

async function finishBatch(
  state: CronServiceState,
  batch: Promise<unknown>,
  runner: ReturnType<typeof blockedRunner>,
) {
  runner.release.resolve({ status: "ok", summary: "completed" });
  await batch;
  state.timer?.cancel();
}

function findCronTask(jobId: string) {
  return readCronRunRecordsForTests().find((task) => task.jobId === jobId);
}

function finalizeError(
  state: CronServiceState,
  job: CronJob,
  error: string,
  options?: Parameters<typeof finalizeCompletedCronRunOutcomes>[2],
) {
  const outcome = authorCronRunCompletion(job, {
    jobId: job.id,
    job: structuredClone(job),
    activeJobMarker: markCronJobActive(job.id),
    status: "error",
    error,
    startedAt: DUE_AT,
    endedAt: DUE_AT + 10,
  });
  return finalizeCompletedCronRunOutcomes(state, [outcome], options);
}

function rejectWrite(
  jobId: string,
  predicate = "json_extract(NEW.state_json, '$.lastRunStatus') = 'ok'",
) {
  const database = openOpenClawStateDatabase().db;
  database.exec(`
    CREATE TRIGGER reject_terminal_write AFTER UPDATE ON cron_jobs
    WHEN NEW.job_id = '${jobId}' AND ${predicate}
    BEGIN SELECT RAISE(ABORT, 'terminal write failed'); END;
  `);
  return () => database.exec("DROP TRIGGER IF EXISTS reject_terminal_write");
}

function observeFinalizationRejection(onRejected: () => void) {
  const execute = runtimeMutation.runCronRuntimeMutation;
  return vi.spyOn(runtimeMutation, "runCronRuntimeMutation").mockImplementation(async (params) => {
    try {
      return await execute(params);
    } catch (error) {
      if (params.type === "cron.finalizeRuns") {
        onRejected();
      }
      throw error;
    }
  });
}

function observeInactiveJobs(jobIds: string[]) {
  // Durable rows can precede the finalizer's schedule maintenance and marker release.
  const inactive = new Map(jobIds.map((jobId) => [jobId, createDeferred()]));
  const markActive = activeJobs.markCronJobActive;
  const observer = vi.spyOn(activeJobs, "markCronJobActive").mockImplementation((...args) => {
    const marker = markActive(...args);
    const completion = inactive.get(args[0]);
    if (completion) {
      activeJobs.onCronJobInactive(marker, () => completion.resolve());
    }
    return marker;
  });
  return {
    settled: Promise.all([...inactive.values()].map((completion) => completion.promise)),
    restore: () => observer.mockRestore(),
  };
}

describe("cron batch outcome finalization", () => {
  it.each([
    { trigger: "scheduled", installSuccessor: false },
    { trigger: "startup", installSuccessor: true },
  ] as const)(
    "supersedes a stale $trigger outcome (successor=$installSuccessor)",
    async ({ trigger, installSuccessor }) => {
      const job = dueJob(`${trigger}-superseded`);
      const runner = blockedRunner();
      let ownerAvailable = true;
      const { state, storePath } = await fixture([job], {
        isAgentAvailable: () => ownerAvailable,
        runIsolatedAgentJob: runner.run,
      });
      const batch = startBatch(trigger, state);
      try {
        await runner.started.promise;
        if (installSuccessor) {
          const stored = await loadCronStore(storePath);
          stored.jobs[0]!.state.runningAtMs = DUE_AT + 1;
          await saveCronStore(storePath, stored);
        }
        ownerAvailable = false;
        runner.release.resolve({ status: "ok", summary: "stale completion" });
        await batch;
        expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(
          installSuccessor ? DUE_AT + 1 : undefined,
        );
        const receipt = openOpenClawStateDatabase()
          .db.prepare(
            "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
          )
          .get(cronStoreKey(storePath), job.id);
        expect(receipt).toMatchObject({ status: "superseded" });
      } finally {
        ownerAvailable = false;
        await finishBatch(state, batch, runner);
      }
    },
  );

  it("recovers one finalized scheduled run when admission advances its execution clock", async () => {
    const job = dueJob("recover-advanced-clock");
    job.state.lastError = "previous failure";
    const startedAt = DUE_AT + 7;
    let now = DUE_AT;
    let reservationPersisted = false;
    const events: CronEvent[] = [];
    const runIsolatedAgentJob = vi.fn(async () => {
      expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(startedAt);
      expect(state.store?.jobs[0]?.state.runningAtMs).toBe(startedAt);
      expect(state.store?.jobs[0]?.state.lastError).toBeUndefined();
      return { status: "ok" as const, summary: "finished before terminal store failure" };
    });
    const { state, storePath } = await fixture([job], {
      nowMs: () => now,
      runIsolatedAgentJob,
      onEvent: (event) => events.push(event),
    });
    const database = openOpenClawStateDatabase().db;
    const stopObserving = observeCronStoreCommits(storePath, () => {
      const queued = database
        .prepare(
          "SELECT 1 FROM cron_jobs WHERE store_key = ? AND job_id = ? AND json_extract(state_json, '$.queuedAtMs') = ?",
        )
        .get(cronStoreKey(storePath), job.id, DUE_AT);
      if (!reservationPersisted && queued) {
        reservationPersisted = true;
        now = startedAt;
      }
    });
    const allowWrites = rejectWrite(job.id);
    let recoveryState: CronServiceState | undefined;
    try {
      await expect(onTimer(state)).rejects.toThrow("terminal write failed");
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(startedAt);
      const task = findCronTask(job.id);
      expect(task).toMatchObject({
        runId: expect.stringMatching(new RegExp(`^${createCronExecutionId(job.id, startedAt)}:`)),
        startedAt,
        status: "succeeded",
        summary: "finished before terminal store failure",
      });
      expect(events.filter((event) => event.action === "started")).toEqual([
        expect.objectContaining({ runAtMs: startedAt }),
      ]);
      expect(events.filter((event) => event.action === "finished")).toEqual([]);
      allowWrites();
      recoveryState = createCronRegressionState({
        storePath,
        nowMs: () => startedAt + 1,
        runIsolatedAgentJob,
        onEvent: (event) => events.push(event),
      });
      await start(recoveryState);
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(readCronRunRecordsForTests().filter((record) => record.jobId === job.id)).toEqual([
        expect.objectContaining({ runId: task?.runId, status: "succeeded" }),
      ]);
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries,
      ).toEqual([
        expect.objectContaining({
          jobId: job.id,
          runAtMs: startedAt,
          status: "ok",
          summary: "finished before terminal store failure",
        }),
      ]);
      expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
        enabled: false,
        state: { lastRunAtMs: startedAt, lastRunStatus: "ok", lastStatus: "ok" },
      });
      expect(events.filter((event) => event.action === "finished")).toHaveLength(0);
    } finally {
      stopObserving();
      allowWrites();
      stop(state);
      if (recoveryState) {
        stop(recoveryState);
      }
    }
  });

  it("does not apply a removed startup run to a same-id replacement", async () => {
    const original = dueJob("removed-replacement", {
      name: "removed original scheduled job",
      deleteAfterRun: true,
    });
    const replacementAt = DUE_AT + 60 * 60_000;
    const runner = blockedRunner();
    const events: CronEvent[] = [];
    const { state, storePath } = await fixture([original], {
      runIsolatedAgentJob: runner.run,
      onEvent: (event) => events.push(event),
    });
    const batch = runMissedJobs(state);
    try {
      await runner.started.promise;
      await expect(remove(state, original.id)).resolves.toEqual({
        ok: true,
        removed: true,
        activeRunCancellationRequested: true,
      });
      await add(state, {
        id: original.id,
        name: "independent replacement scheduled job",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(replacementAt).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "run only the replacement occurrence" },
        delivery: { mode: "none" },
      });
      runner.release.resolve({ status: "ok", summary: "removed original completed" });
      await batch;
      for (const jobs of [state.store?.jobs ?? [], (await loadCronStore(storePath)).jobs]) {
        const replacement = jobs.find((job) => job.id === original.id);
        expect(replacement).toMatchObject({
          id: original.id,
          name: "independent replacement scheduled job",
          enabled: true,
          deleteAfterRun: true,
          state: { nextRunAtMs: replacementAt },
        });
        expect(replacement?.state.lastRunAtMs).toBeUndefined();
        expect(replacement?.state.lastRunStatus).toBeUndefined();
        expect(replacement?.state.lastStatus).toBeUndefined();
        expect(replacement?.state.runningAtMs).toBeUndefined();
      }
      expect(
        events.filter((event) => event.action === "finished" && event.jobId === original.id),
      ).toEqual([
        expect.objectContaining({
          job: expect.objectContaining({ name: "removed original scheduled job" }),
        }),
      ]);
      expect(isCronJobActive(original.id)).toBe(false);
    } finally {
      await finishBatch(state, batch, runner);
    }
  });

  it("notifies the owning agent once after a recurring auto-disable is durable", async () => {
    const job = dueJob("recurring-auto-disable-notification", {
      name: "Recurring report",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: DUE_AT - 60_000 },
      state: { nextRunAtMs: DUE_AT, consecutiveErrors: 9, runningAtMs: DUE_AT },
    });
    const order: string[] = [];
    const deliveryContext = { channel: "discord", to: "channel-1", accountId: "default" };
    const resolveOriginDeliveryContext = vi.fn(() => deliveryContext);
    const enqueueSystemEvent = vi.fn<CronServiceDeps["enqueueSystemEvent"]>(() => {
      const persisted = openOpenClawStateDatabase()
        .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(cronStoreKey(storePath), job.id);
      expect(persisted).toMatchObject({ enabled: 0 });
      order.push("notify");
    });
    const requestHeartbeat = vi.fn(() => {
      order.push("heartbeat");
    });
    const { state, storePath } = await fixture([job], {
      nowMs: () => DUE_AT + 10,
      defaultAgentId: "main",
      enqueueSystemEvent,
      resolveOriginDeliveryContext,
      requestHeartbeat,
    });
    await finalizeError(state, job, "cron: job execution timed out at /private/agent/work");
    expect(order).toEqual(["notify", "heartbeat"]);
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`openclaw automations enable ${job.id}`),
      {
        agentId: "main",
        sessionKey: undefined,
        contextKey: `cron:${job.id}:auto-disabled`,
        deliveryContext,
      },
    );
    const text = enqueueSystemEvent.mock.calls[0]?.[0];
    expect(text).toContain("Recurring report");
    expect(text).toContain(job.id);
    expect(text).toContain("10 consecutive run failures");
    expect(text).toContain("Cause: timeout");
    expect(text).not.toContain("/private/agent/work");
    expect(resolveOriginDeliveryContext).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: undefined,
    });
    expect(requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "notifications-event",
        intent: "immediate",
        reason: "wake",
        agentId: "main",
      }),
    );
    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      enabled: false,
      state: {
        consecutiveErrors: 10,
        lastError: "cron: job execution timed out at /private/agent/work",
        autoDisabled: { reason: "consecutive-failures", atMs: DUE_AT + 10, consecutiveErrors: 10 },
      },
    });
  });

  it("rolls back recurring auto-disable without notifying when persistence fails", async () => {
    const job = dueJob("recurring-auto-disable-rollback", {
      schedule: { kind: "every", everyMs: 60_000, anchorMs: DUE_AT - 60_000 },
      state: { nextRunAtMs: DUE_AT, consecutiveErrors: 9, runningAtMs: DUE_AT },
    });
    const { state, storePath } = await fixture([job], { nowMs: () => DUE_AT + 10 });
    const allowWrites = rejectWrite(
      job.id,
      "json_extract(NEW.state_json, '$.autoDisabled') IS NOT NULL",
    );
    try {
      await expect(finalizeError(state, job, "tenth failure")).rejects.toThrow(
        "terminal write failed",
      );
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
      expect(state.store?.jobs[0]?.enabled).toBe(true);
      expect(state.store?.jobs[0]?.state.autoDisabled).toBeUndefined();
      expect((await loadCronStore(storePath)).jobs[0]?.enabled).toBe(true);
    } finally {
      allowWrites();
    }
  });

  it("clears retired setup-timeout markers without rewriting stopped-service state", async () => {
    const job = dueJob("stopped-setup-timeout-marker", {
      state: { nextRunAtMs: DUE_AT, runningAtMs: DUE_AT },
    });
    const { state, storePath } = await fixture([job]);
    state.stopped = true;
    expect(
      await finalizeError(state, job, "setup timed out before runner start", {
        clearOnFailure: false,
        discardWhenStopped: true,
      }),
    ).toEqual([]);
    expect(isCronJobActive(job.id)).toBe(false);
    expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(DUE_AT);
  });

  it("persists a completed scheduled run when its service stops during execution", async () => {
    const job = dueJob("scheduled-completion-during-stop");
    const runner = blockedRunner();
    const { state, storePath } = await fixture([job], { runIsolatedAgentJob: runner.run });
    const batch = onTimer(state);
    try {
      await runner.started.promise;
      state.stopped = true;
      runner.release.resolve({ status: "ok", summary: "finished during shutdown" });
      await batch;
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.lastRunStatus).toBe("ok");
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(findCronTask(job.id)?.status).toBe("succeeded");
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(isCronJobActive(job.id)).toBe(false);
    } finally {
      await finishBatch(state, batch, runner);
    }
  });

  it("drains later scheduled completions after a sibling terminal write fails", async () => {
    const first = dueJob("failed-terminal-write");
    const second = dueJob("completion-after-terminal-failure");
    const runner = blockedRunner(second.id);
    const { state, storePath } = await fixture([first, second], {
      runIsolatedAgentJob: runner.run,
    });
    const allowWrites = rejectWrite(first.id);
    const failed = createDeferred();
    const observer = observeFinalizationRejection(() => failed.resolve());
    const batch = onTimer(state).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await failed.promise;
      await runner.started.promise;
      runner.release.resolve({ status: "ok", summary: "later completion" });
      expect(await batch).toEqual(expect.objectContaining({ message: "terminal write failed" }));
      const persisted = (await loadCronStore(storePath)).jobs.find((job) => job.id === second.id);
      expect(persisted?.state.lastRunStatus).toBe("ok");
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(isCronJobActive(first.id)).toBe(false);
      expect(isCronJobActive(second.id)).toBe(false);
    } finally {
      await finishBatch(state, batch, runner);
      observer.mockRestore();
      allowWrites();
    }
  });

  it("releases unstarted startup reservations when terminal finalization fails", async () => {
    const first = dueJob("startup-failed-write-before-stop");
    const unstarted = dueJob("startup-unstarted-after-failed-write");
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "completed before service stop",
    }));
    const { state, storePath } = await fixture([first, unstarted], { runIsolatedAgentJob });
    const allowWrites = rejectWrite(first.id);
    const observer = observeFinalizationRejection(() => stop(state));
    try {
      await expect(runMissedJobs(state)).rejects.toThrow("terminal write failed");
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      const persisted = (await loadCronStore(storePath)).jobs.find(
        (job) => job.id === unstarted.id,
      );
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(isCronJobActive(first.id)).toBe(false);
      expect(isCronJobActive(unstarted.id)).toBe(false);
    } finally {
      observer.mockRestore();
      allowWrites();
      state.timer?.cancel();
    }
  });

  it.each([
    { trigger: "scheduled", concurrency: 2, deleteAfterRun: true },
    { trigger: "startup", concurrency: 1, deleteAfterRun: false },
  ] as const)(
    "persists a completed $trigger job before its sibling drains",
    async ({ trigger, concurrency, deleteAfterRun }) => {
      const first = dueJob(`${trigger}-finished`, { deleteAfterRun });
      const second = dueJob(`${trigger}-blocked`);
      const runner = blockedRunner(second.id);
      const events: CronEvent[] = [];
      const { state, storePath } = await fixture([first, second], {
        runIsolatedAgentJob: runner.run,
        testAdmissionLimit: concurrency,
        onEvent: (event) => events.push(event),
      });

      const inactive = observeInactiveJobs([first.id]);
      const batch = startBatch(trigger, state);
      try {
        await runner.started.promise;
        await inactive.settled;
        const jobs = (await loadCronStore(storePath)).jobs;
        const persisted = jobs.find((job) => job.id === first.id);
        if (deleteAfterRun) {
          expect(persisted).toBeUndefined();
        } else {
          expect(persisted?.state.lastRunStatus).toBe("ok");
          expect(persisted?.state.runningAtMs).toBeUndefined();
        }
        expect(jobs.find((job) => job.id === second.id)?.state.runningAtMs).toBe(DUE_AT);
        expect(findCronTask(first.id)?.status).toBe("succeeded");
        expect(findCronTask(second.id)).toBeUndefined();
        expect(isCronJobActive(first.id)).toBe(false);
        expect(isCronJobActive(second.id)).toBe(true);
        expect(events).toContainEqual(
          expect.objectContaining({ action: "finished", jobId: first.id, status: "ok" }),
        );
        if (deleteAfterRun) {
          expect(events).toContainEqual(
            expect.objectContaining({ action: "removed", jobId: first.id }),
          );
        }
      } finally {
        inactive.restore();
        await finishBatch(state, batch, runner);
      }
      expect(findCronTask(second.id)?.status).toBe("succeeded");
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
    },
  );

  it.each(["scheduled", "startup"] as const)(
    "durably finalizes a large %s batch while its final run remains active",
    async (trigger) => {
      const store = fixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
      const jobCount = 32;
      const jobs: CronJob[] = Array.from({ length: jobCount }, (_, index) =>
        createDueIsolatedJob({
          id: `${trigger}-stress-${String(index).padStart(2, "0")}`,
          nowMs: dueAt,
          nextRunAtMs: dueAt,
        }),
      );
      await saveCronStore(store.storePath, { version: 1, jobs });

      const lastJob = jobs.at(-1);
      if (!lastJob) {
        throw new Error("expected a final cron stress-test job");
      }
      const finalRunStarted = createDeferred();
      const releaseFinalRun = createDeferred<{ status: "ok"; summary: string }>();
      const clock = createGatewaySchedulerClock(dueAt);
      const state = createCronRegressionState({
        scheduler: createTestGatewayScheduler(clock.clock),
        storePath: store.storePath,
        nowMs: () => dueAt,
        maxMissedJobsPerRestart: 40,
        runIsolatedAgentJob: vi.fn(async ({ job }) => {
          if (job.id === lastJob.id) {
            finalRunStarted.resolve();
            return await releaseFinalRun.promise;
          }
          return { status: "ok" as const, summary: `finished ${job.id}` };
        }),
      });

      const inactive = observeInactiveJobs(jobs.slice(0, -1).map((job) => job.id));
      let activeBatch = startBatch(trigger, state);
      const batches = [activeBatch];
      const finalStarted = finalRunStarted.promise.then(() => true);
      let reachedFinalRun = false;
      try {
        for (let wave = 0; wave < jobCount; wave += 1) {
          if (await Promise.race([finalStarted, activeBatch.then(() => false)])) {
            reachedFinalRun = true;
            break;
          }
          const capacityTick = clock.advanceBy(0);
          if (!capacityTick) {
            throw new Error("Expected a capacity wake before the final cron job");
          }
          activeBatch = capacityTick;
          batches.push(capacityTick);
        }
        expect(reachedFinalRun).toBe(true);
        await inactive.settled;
        const persistedJobs = (await loadCronStore(store.storePath)).jobs;
        expect(
          persistedJobs.filter((job) => job.id !== lastJob.id && job.state.lastRunStatus === "ok"),
        ).toHaveLength(jobCount - 1);
        expect(persistedJobs.find((job) => job.id === lastJob.id)?.state.runningAtMs).toBe(dueAt);

        for (const job of jobs.slice(0, -1)) {
          expect(findCronTask(job.id)?.status).toBe("succeeded");
          expect(isCronJobActive(job.id)).toBe(false);
        }
        expect(findCronTask(lastJob.id)).toBeUndefined();
        expect(isCronJobActive(lastJob.id)).toBe(true);
      } finally {
        inactive.restore();
        releaseFinalRun.resolve({ status: "ok", summary: "finished final job" });
        await Promise.all(batches);
        stop(state);
        await state.schedulerDrain;
      }

      expect(findCronTask(lastJob.id)?.status).toBe("succeeded");
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
    },
  );
});
