import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
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
import type { CronJob, CronRunErrorClassification } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import { add, remove } from "./ops-mutations.js";
import type { CronEvent, CronServiceDeps, CronServiceState } from "./state.js";
import { authorCronRunCompletion } from "./timer-job-runner.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { onTimer, runMissedJobs } from "./timer.test-support.js";

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

async function finishBatch(batch: Promise<unknown>, runner: ReturnType<typeof blockedRunner>) {
  runner.release.resolve({ status: "ok", summary: "completed" });
  await batch;
}

function findCronTask(jobId: string) {
  return readCronRunRecordsForTests().find((task) => task.jobId === jobId);
}

function finalizeError(
  state: CronServiceState,
  job: CronJob,
  error: string,
  options?: Parameters<typeof finalizeCompletedCronRunOutcomes>[2],
  errorClassification?: CronRunErrorClassification,
) {
  const outcome = authorCronRunCompletion(job, {
    jobId: job.id,
    job: structuredClone(job),
    activeJobMarker: markCronJobActive(job.id),
    status: "error",
    error,
    ...(errorClassification ? { errorClassification } : {}),
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
  const execute = workerStore.executeOpenClawStateWorker;
  return vi
    .spyOn(workerStore, "executeOpenClawStateWorker")
    .mockImplementation(async (context, command) => {
      try {
        return await execute(context, command);
      } catch (error) {
        if (command.type === "cron.finalizeRuns") {
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
    { trigger: "scheduled", change: "owner unavailable" },
    { trigger: "startup", change: "owner unavailable" },
    { trigger: "scheduled", change: "service stopped" },
  ] as const)("records a completed $trigger outcome after $change", async ({ trigger, change }) => {
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
      if (change === "service stopped") {
        state.stopped = true;
      } else {
        ownerAvailable = false;
      }
      runner.release.resolve({ status: "ok", summary: "stale completion" });
      await batch;
      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.lastRunStatus).toBe("ok");
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(isCronJobActive(job.id)).toBe(false);
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(storePath), job.id);
      expect(receipt).toMatchObject({ status: "ok" });
      expect(findCronTask(job.id)).toMatchObject({
        status: "succeeded",
        summary: "stale completion",
      });
    } finally {
      ownerAvailable = false;
      await finishBatch(batch, runner);
    }
  });

  it("records an interrupted run without replay when terminal accounting fails after the execution clock advances", async () => {
    const job = dueJob("recover-advanced-clock");
    job.state.lastError = "previous failure";
    const startedAt = DUE_AT + 7;
    let now = startedAt;
    const events: CronEvent[] = [];
    const runIsolatedAgentJob = vi.fn(async () => {
      expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(startedAt);
      expect(state.store?.jobs[0]?.state.runningAtMs).toBe(startedAt);
      expect(state.store?.jobs[0]?.state.lastError).toBe("previous failure");
      now = startedAt + 7;
      return { status: "ok" as const, summary: "finished before terminal store failure" };
    });
    const { state, storePath } = await fixture([job], {
      nowMs: () => now,
      runIsolatedAgentJob,
      onEvent: (event) => events.push(event),
    });
    const allowWrites = rejectWrite(job.id);
    let recoveryState: CronServiceState | undefined;
    try {
      await expect(onTimer(state)).rejects.toThrow("terminal write failed");
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(startedAt);
      expect(findCronTask(job.id)).toBeUndefined();
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
        expect.objectContaining({
          runId: expect.stringMatching(new RegExp(`^${createCronExecutionId(job.id, startedAt)}:`)),
          startedAt,
          status: "failed",
          error: "cron: job interrupted by gateway restart",
        }),
      ]);
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries,
      ).toEqual([
        expect.objectContaining({
          jobId: job.id,
          runAtMs: startedAt,
          status: "error",
          error: "cron: job interrupted by gateway restart",
        }),
      ]);
      expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
        enabled: false,
        state: { lastRunAtMs: startedAt, lastRunStatus: "error", lastStatus: "error" },
      });
      expect(events.filter((event) => event.action === "finished")).toHaveLength(1);
    } finally {
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
      await finishBatch(batch, runner);
    }
  });

  it.each(["owning agent", "failure route"] as const)(
    "durably auto-disables before notifying the %s",
    async (route) => {
      const routed = route === "failure route";
      const job = dueJob("recurring-auto-disable", {
        name: "Recurring report",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: DUE_AT - 60_000 },
        state: {
          nextRunAtMs: DUE_AT,
          consecutiveErrors: 9,
          runningAtMs: DUE_AT,
          // An earlier threshold alert must not suppress the auto-disable notice.
          ...(routed ? { lastFailureAlertAtMs: DUE_AT - 30_000 } : {}),
        },
        ...(routed
          ? { failureAlert: { mode: "webhook" as const, to: "https://alerts.example.com/hook" } }
          : {}),
      });
      const order: string[] = [];
      const deliveryContext = { channel: "discord", to: "channel-1", accountId: "default" };
      const resolveOriginDeliveryContext = vi.fn(async () => deliveryContext);
      const enqueueSystemEvent = vi.fn<CronServiceDeps["enqueueSystemEvent"]>(() => {
        expect(
          openOpenClawStateDatabase()
            .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
            .get(cronStoreKey(storePath), job.id),
        ).toMatchObject({ enabled: 0 });
        order.push("notify");
      });
      const requestHeartbeat = vi.fn(() => {
        order.push("heartbeat");
      });
      const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
        async () => {},
      );
      const { state, storePath } = await fixture([job], {
        nowMs: () => DUE_AT + 10,
        defaultAgentId: "main",
        enqueueSystemEvent,
        requestHeartbeat,
        ...(routed ? { sendCronFailureAlert } : { resolveOriginDeliveryContext }),
      });
      const cause = routed ? "server_error" : "timeout";
      const error = routed
        ? "cron: provider returned HTTP 500 at /private/agent/work"
        : "cron: job execution timed out at /private/agent/work";
      await finalizeError(state, job, error, undefined, { kind: "reason", reason: cause });
      const text = routed
        ? sendCronFailureAlert.mock.calls[0]?.[0].payload.text
        : enqueueSystemEvent.mock.calls[0]?.[0];
      for (const fragment of [
        "Recurring report",
        job.id,
        "10 consecutive run failures",
        `Cause: ${cause}`,
        `openclaw automations enable ${job.id}`,
      ]) {
        expect(text).toContain(fragment);
      }
      if (routed) {
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expect(sendCronFailureAlert.mock.calls[0]?.[0]).toMatchObject({
          mode: "webhook",
          to: "https://alerts.example.com/hook",
        });
        expect(text).toContain('Automation "Recurring report" was auto-disabled');
        expect(text).toContain(`Last error: ${error}`);
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
      } else {
        expect(order).toEqual(["notify", "heartbeat"]);
        expect(text).not.toContain("/private/agent/work");
        expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(`openclaw automations enable ${job.id}`),
          {
            agentId: "main",
            sessionKey: undefined,
            contextKey: `cron:${job.id}:auto-disabled`,
            deliveryContext,
          },
        );
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
      }
      expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
        enabled: false,
        state: {
          consecutiveErrors: 10,
          lastError: error,
          autoDisabled: {
            reason: "consecutive-failures",
            atMs: DUE_AT + 10,
            consecutiveErrors: 10,
          },
          ...(routed
            ? {
                lastFailureAlertAtMs: DUE_AT + 10,
                lastFailureNotificationDeliveryStatus: "unknown",
              }
            : {}),
        },
      });
    },
  );

  it("records a completed setup timeout and clears its active marker while the service is stopped", async () => {
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
    const persisted = (await loadCronStore(storePath)).jobs[0]?.state;
    expect(persisted?.runningAtMs).toBeUndefined();
    expect(persisted?.lastRunStatus).toBe("error");
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
      expect(isCronJobActive(first.id)).toBe(false);
      expect(isCronJobActive(second.id)).toBe(false);
    } finally {
      await finishBatch(batch, runner);
      observer.mockRestore();
      allowWrites();
    }
  });

  it("keeps a deferred startup job unrequested when immediate finalization fails", async () => {
    const first = dueJob("startup-failed-write-before-stop");
    const unstarted = dueJob("startup-unstarted-after-failed-write");
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "completed before service stop",
    }));
    const { state, storePath } = await fixture([first, unstarted], {
      maxMissedJobsPerRestart: 1,
      runIsolatedAgentJob,
    });
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
      expect(persisted?.state.nextRunAtMs).toBe(DUE_AT + 5_000);
      expect(isCronJobActive(first.id)).toBe(false);
      expect(isCronJobActive(unstarted.id)).toBe(false);
    } finally {
      observer.mockRestore();
      allowWrites();
    }
  });

  it("persists a completed startup job before its sibling drains", async () => {
    const first = dueJob("startup-finished", { deleteAfterRun: false });
    const second = dueJob("startup-blocked");
    const runner = blockedRunner(second.id);
    const events: CronEvent[] = [];
    const { state, storePath } = await fixture([first, second], {
      runIsolatedAgentJob: runner.run,
      onEvent: (event) => events.push(event),
    });

    const inactive = observeInactiveJobs([first.id]);
    const batch = runMissedJobs(state);
    try {
      await runner.started.promise;
      await inactive.settled;
      const jobs = (await loadCronStore(storePath)).jobs;
      const persisted = jobs.find((job) => job.id === first.id);
      expect(persisted?.state.lastRunStatus).toBe("ok");
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(jobs.find((job) => job.id === second.id)?.state.runningAtMs).toBe(DUE_AT);
      expect(findCronTask(first.id)?.status).toBe("succeeded");
      expect(findCronTask(second.id)).toBeUndefined();
      expect(isCronJobActive(first.id)).toBe(false);
      expect(isCronJobActive(second.id)).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({ action: "finished", jobId: first.id, status: "ok" }),
      );
    } finally {
      inactive.restore();
      await finishBatch(batch, runner);
    }
    expect(findCronTask(second.id)?.status).toBe("succeeded");
  });

  it("durably finalizes a large scheduled batch while its final run remains active", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const jobCount = 32;
    const jobs = Array.from({ length: jobCount }, (_, index) =>
      createDueIsolatedJob({
        id: `scheduled-stress-${String(index).padStart(2, "0")}`,
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      }),
    );

    const lastJob = jobs.at(-1);
    if (!lastJob) {
      throw new Error("expected a final cron stress-test job");
    }
    const runner = blockedRunner(lastJob.id);
    const clock = createGatewaySchedulerClock(dueAt);
    const { state, storePath } = await fixture(jobs, {
      scheduler: createTestGatewayScheduler(clock.clock),
      nowMs: () => dueAt,
      runIsolatedAgentJob: runner.run,
    });

    const inactive = observeInactiveJobs(jobs.slice(0, -1).map((job) => job.id));
    let activeBatch = onTimer(state);
    const batches = [activeBatch];
    const finalStarted = runner.started.promise.then(() => true);
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
      const persistedJobs = (await loadCronStore(storePath)).jobs;
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
      runner.release.resolve({ status: "ok", summary: "finished final job" });
      await Promise.all(batches);
      stop(state);
      await state.schedulerDrain;
    }

    expect(findCronTask(lastJob.id)?.status).toBe("succeeded");
  });
});
