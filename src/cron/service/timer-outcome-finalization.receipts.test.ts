import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  advanceCronActiveJobGeneration,
  clearCronJobActive,
  isCronActiveJobMarkerCurrent,
  markCronJobActive,
} from "../active-jobs.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { readCronRunRecordsForTests } from "../run-history.test-support.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimLocalCronRunReceiptOwnership,
  isCronRunReceiptOwnerStale,
} from "../store/run-receipt-store.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  inspectActiveCronRunReceipt,
  finishCronRunReceiptAsync,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.test-support.js";
import { createCronScheduledRunId, parseCronScheduledRunId } from "../store/run-request-id.js";
import type { CronJob } from "../types.js";
import { createCronRunHandle } from "./run-history.js";
import { createCronServiceState } from "./state.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import { authorCronRunCompletion } from "./timer-job-runner.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-finalization-receipts-" });

function claimReceipt(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    observed: undefined,
    storePath,
    job,
    agentId: job.agentId ?? "main",
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabaseForTest({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId ?? "main",
    }),
  );
}

function authorOutcome(outcome: Omit<TimedCronRunOutcome, "completionStatus" | "deliveryState">) {
  return authorCronRunCompletion(outcome.job, outcome);
}

describe("cron outcome receipt finalization", () => {
  it.each([false, true])(
    "preserves authored rows while finalizing a retired outcome without consuming a same-millisecond successor (replaced=%s)",
    async (replaced) => {
      const store = fixtures.makeStorePath();
      const startedAt = Date.now();
      const retired = createDueIsolatedJob({
        id: "retired-batch",
        nowMs: startedAt,
        nextRunAtMs: startedAt,
      });
      const current = createDueIsolatedJob({
        id: "current-batch",
        nowMs: startedAt,
        nextRunAtMs: startedAt,
      });
      retired.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
      retired.deleteAfterRun = false;
      retired.state.runningAtMs = startedAt;
      current.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      current.deleteAfterRun = false;
      current.state.runningAtMs = startedAt;
      await saveCronStore(store.storePath, { version: 1, jobs: [retired, current] });
      const runReceiptContext = captureOpenClawStateWorkerContext();
      const retiredReceipt = claimReceipt(store.storePath, retired, startedAt);
      const currentReceipt = claimReceipt(store.storePath, current, startedAt);
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => startedAt,
        runIsolatedAgentJob: vi.fn(),
      });
      const taskRunId = createCronRunHandle({
        state,
        job: retired,
        startedAt,
        runReceipt: retiredReceipt,
      }).runId;
      const retiredMarker = markCronJobActive(retired.id);
      advanceCronActiveJobGeneration();
      const currentMarker = markCronJobActive(current.id);
      let successor: ReturnType<typeof claimReceipt> | undefined;
      if (replaced) {
        await finishCronRunReceiptAsync({
          handle: retiredReceipt,
          status: "superseded",
          finishedAtMs: startedAt,
        });
        successor = claimReceipt(store.storePath, retired, startedAt);
      }
      const database = openOpenClawStateDatabase().db;
      const storeKey = cronStoreKey(store.storePath);
      database
        .prepare(
          `UPDATE cron_jobs
           SET agent_id = 'main', owner_agent_id = 'main', grant_definition_generation = 17,
               job_json = json_set(json_remove(job_json, '$.enabled'),
                 '$.notify', json('true'), '$.authoredNote', 'preserve me')
           WHERE store_key = ?`,
        )
        .run(storeKey);
      const readDefinitions = () =>
        database
          .prepare(
            `SELECT job_id, job_json, enabled, agent_id, owner_agent_id, sort_order, updated_at,
                    grant_definition_revision, grant_definition_generation, grant_definition_updated_at
             FROM cron_jobs WHERE store_key = ? ORDER BY sort_order`,
          )
          .all(storeKey);
      const definitionsBefore = readDefinitions();
      expect(definitionsBefore).toHaveLength(2);
      try {
        await finalizeCompletedCronRunOutcomes(state, [
          authorOutcome({
            jobId: retired.id,
            job: retired,
            taskRunId,
            activeJobMarker: retiredMarker,
            runReceipt: retiredReceipt,
            runReceiptContext,
            status: "ok",
            startedAt,
            endedAt: startedAt,
          }),
          authorOutcome({
            jobId: current.id,
            job: current,
            activeJobMarker: currentMarker,
            runReceipt: currentReceipt,
            runReceiptContext,
            status: "ok",
            startedAt,
            endedAt: startedAt,
          }),
        ]);
        const persisted = (await loadCronStore(store.storePath)).jobs.find(
          (job) => job.id === retired.id,
        );
        if (successor) {
          expect(persisted?.state.runningAtMs).toBe(startedAt);
          expect(persisted?.state.lastRunStatus).toBeUndefined();
          expect(
            inspectActiveCronRunReceipt({ storePath: store.storePath, jobId: retired.id })
              ?.receiptId,
          ).toBe(successor.receiptId);
        } else {
          expect(persisted).toMatchObject({ enabled: false, state: { lastRunStatus: "ok" } });
          expect(persisted?.state.runningAtMs).toBeUndefined();
        }
        expect(state.store?.jobs.find((job) => job.id === retired.id)).toEqual(persisted);
        const expectedDefinitions = structuredClone(definitionsBefore);
        for (const row of expectedDefinitions) {
          if (replaced || row.job_id !== retired.id) {
            continue;
          }
          if (typeof row.job_json !== "string") {
            throw new Error("Expected persisted cron definition JSON.");
          }
          row.enabled = 0;
          row.job_json = JSON.stringify({ ...JSON.parse(row.job_json), enabled: false });
        }
        expect(readDefinitions()).toEqual(expectedDefinitions);
        expect(
          database
            .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
            .get(currentReceipt.receiptId),
        ).toEqual({ status: "ok" });
        expect(
          database
            .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
            .get(retiredReceipt.receiptId),
        ).toEqual({ status: replaced ? "superseded" : "ok" });
      } finally {
        if (successor) {
          await finishCronRunReceiptAsync({
            handle: successor,
            status: "skipped",
            finishedAtMs: startedAt,
          });
        }
      }
    },
  );

  it("emits only committed authoritative outcomes after a rejected batch attempt", async () => {
    const store = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:04:59.250Z");
    const stale = createDueIsolatedJob({
      id: "rejected-event",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    const current = createDueIsolatedJob({
      id: "committed-event",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    stale.state.runningAtMs = startedAt;
    current.state.runningAtMs = startedAt;
    await saveCronStore(store.storePath, { version: 1, jobs: [stale, current] });
    const runReceiptContext = captureOpenClawStateWorkerContext();
    const staleReceipt = claimReceipt(store.storePath, stale, startedAt);
    const currentReceipt = claimReceipt(store.storePath, current, startedAt);
    await finishCronRunReceiptAsync({
      handle: staleReceipt,
      status: "superseded",
      finishedAtMs: startedAt + 1,
    });
    const edited = await loadCronStore(store.storePath);
    edited.jobs.find((job) => job.id === current.id)!.name = "authoritative edited name";
    await saveCronStore(store.storePath, edited);
    const events: Array<{ action: string; jobId: string; job?: CronJob }> = [];
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => startedAt + 2,
      runIsolatedAgentJob: vi.fn(),
      onEvent: (event) => events.push(event),
    });

    await finalizeCompletedCronRunOutcomes(state, [
      authorOutcome({
        jobId: stale.id,
        job: stale,
        activeJobMarker: markCronJobActive(stale.id),
        runReceipt: staleReceipt,
        runReceiptContext,
        status: "ok",
        startedAt,
        endedAt: startedAt + 2,
      }),
      authorOutcome({
        jobId: current.id,
        job: current,
        activeJobMarker: markCronJobActive(current.id),
        runReceipt: currentReceipt,
        runReceiptContext,
        status: "ok",
        startedAt,
        endedAt: startedAt + 2,
      }),
    ]);

    expect(events.filter((event) => event.action === "finished")).toEqual([
      expect.objectContaining({
        jobId: current.id,
        job: expect.objectContaining({ name: "authoritative edited name" }),
      }),
    ]);
  });

  it("settles mixed outcomes despite one deferred release failure without clearing a successor", async () => {
    const { storePath } = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:04:59.375Z");
    const makeJob = (id: string) => {
      const job = createDueIsolatedJob({ id, nowMs: startedAt, nextRunAtMs: startedAt });
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      return job;
    };
    const completedJob = makeJob("mixed-completed");
    const failedJob = makeJob("mixed-deferred-release-fails");
    const laterJob = makeJob("mixed-later-deferred");
    const replacedJob = makeJob("mixed-replaced-deferred");
    await saveCronStore(storePath, {
      version: 1,
      jobs: [completedJob, failedJob, laterJob, replacedJob],
    });
    const state = createCronRegressionState({
      storePath,
      defaultAgentId: "main",
      nowMs: () => startedAt,
      runIsolatedAgentJob: vi.fn(),
    });
    const runReceiptContext = captureOpenClawStateWorkerContext();
    const reserveRun = async (job: CronJob, scheduled = false) => {
      const receiptId = scheduled
        ? createCronScheduledRunId(cronStoreKey(storePath), job.id, startedAt)
        : `mixed-${job.id}-${randomUUID()}`;
      const mode = scheduled ? ("scheduled" as const) : ("force" as const);
      await runOpenClawStateWorkerOperation(runReceiptContext, (scope) =>
        scope.execute({
          type: "cron.requestRuns",
          input: {
            storeKey: cronStoreKey(storePath),
            nowMs: startedAt,
            defaultAgentId: "main",
            requests: [
              {
                receiptId,
                jobId: job.id,
                configRevision: resolveCronJobConfigRevision(job),
                mode,
                ...(scheduled ? { scheduledSlotMs: startedAt } : {}),
              },
            ],
          },
        }),
      );
      const { launches } = await runOpenClawStateWorkerOperation(runReceiptContext, (scope) =>
        scope.execute({
          type: "cron.drainQueue",
          input: {
            storeKey: cronStoreKey(storePath),
            nowMs: startedAt,
            defaultAgentId: "main",
            maxConcurrentRuns: 4,
            requests: [{ receiptId, mode }],
          },
        }),
      );
      const activation = launches.find((entry) => entry.job.id === job.id);
      if (!activation) {
        throw new Error("Expected the worker queue to activate the requested receipt");
      }
      claimLocalCronRunReceiptOwnership(activation.runReceipt);
      return {
        ...activation,
        jobId: job.id,
        startedAt,
        runReceiptContext,
        activeJobMarker: markCronJobActive(job.id),
        taskRunId: createCronRunHandle({
          state,
          job: activation.job,
          startedAt,
          runReceipt: activation.runReceipt,
        }).runId,
        endedAt: startedAt + 1,
      };
    };
    const completed = await reserveRun(completedJob);
    const failed = await reserveRun(failedJob);
    const later = await reserveRun(laterJob, true);
    const predecessor = await reserveRun(replacedJob);
    await runOpenClawStateWorkerOperation(runReceiptContext, (scope) =>
      scope.execute({
        type: "cron.cancelRequests",
        input: {
          storeKey: cronStoreKey(storePath),
          receiptIds: [predecessor.runReceipt.receiptId],
          nowMs: startedAt,
          reason: "Replaced before idle admission",
          status: "superseded",
        },
      }),
    );
    const replacement = (await loadCronStore(storePath)).jobs.find(
      (job) => job.id === replacedJob.id,
    );
    if (!replacement) {
      throw new Error("Expected the replacement's existing job definition");
    }
    const successor = await reserveRun(replacement);
    expect(successor.startedAt).toBe(predecessor.startedAt);
    expect(successor.runReceipt.receiptId).not.toBe(predecessor.runReceipt.receiptId);
    const database = openOpenClawStateDatabase().db;
    const readReceipt = (run: typeof completed) =>
      database
        .prepare("SELECT status, finished_at_ms FROM cron_run_receipts WHERE receipt_id = ?")
        .get(run.runReceipt.receiptId);
    database.exec(`
      CREATE TRIGGER reject_mixed_deferred_release
      BEFORE UPDATE OF status ON cron_run_receipts
      WHEN OLD.receipt_id = '${failed.runReceipt.receiptId}' AND NEW.status = 'skipped'
      BEGIN
        SELECT RAISE(ABORT, 'deferred release unavailable');
      END;
    `);
    const deferredOutcome = (run: typeof completed) =>
      authorOutcome({
        ...run,
        status: "skipped",
        admissionDeferred: true,
        executionStarted: false,
      });

    let retriedLater: Awaited<ReturnType<typeof reserveRun>> | undefined;
    try {
      const failure = await finalizeCompletedCronRunOutcomes(state, [
        deferredOutcome(failed),
        authorOutcome({ ...completed, status: "ok" }),
        deferredOutcome(predecessor),
        deferredOutcome(later),
      ]).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(readReceipt(completed)).toEqual({ status: "ok", finished_at_ms: startedAt + 1 });
      expect(readCronRunRecordsForTests(completed.jobId)).toEqual([
        expect.objectContaining({ runId: completed.taskRunId, status: "succeeded" }),
      ]);
      expect(readReceipt(later)).toEqual({ status: "skipped", finished_at_ms: startedAt + 1 });
      expect(readCronRunRecordsForTests(later.jobId)).toEqual([]);
      const persisted = (await loadCronStore(storePath)).jobs;
      const laterPersisted = persisted.find((job) => job.id === later.jobId);
      expect(laterPersisted?.state.nextRunAtMs).toBe(startedAt);
      expect(laterPersisted?.state.runningAtMs).toBeUndefined();
      expect(laterPersisted?.state.lastRunStatus).toBeUndefined();
      expect(readReceipt(failed)).toEqual({ status: "running", finished_at_ms: null });
      expect(readCronRunRecordsForTests(failed.jobId)).toEqual([]);
      expect(persisted.find((job) => job.id === failed.jobId)?.state).toMatchObject({
        runningAtMs: startedAt,
        runningReceiptId: failed.runReceipt.receiptId,
        nextRunAtMs: startedAt,
      });
      expect(isCronRunReceiptOwnerStale(failed.runReceipt, startedAt)).toBe(true);
      for (const run of [completed, failed, later]) {
        expect(isCronActiveJobMarkerCurrent(run.activeJobMarker)).toBe(false);
      }
      expect(readReceipt(predecessor)).toEqual({ status: "superseded", finished_at_ms: startedAt });
      expect(readReceipt(successor)).toEqual({ status: "running", finished_at_ms: null });
      expect(persisted.find((job) => job.id === successor.jobId)?.state).toMatchObject({
        runningAtMs: startedAt,
        runningReceiptId: successor.runReceipt.receiptId,
      });
      expect(isCronActiveJobMarkerCurrent(successor.activeJobMarker)).toBe(true);
      expect(isCronRunReceiptOwnerStale(successor.runReceipt, startedAt)).toBe(false);
      expect(failure).toMatchObject({
        errors: [
          expect.objectContaining({
            message: expect.stringContaining("deferred release unavailable"),
          }),
        ],
      });
      retriedLater = await reserveRun(laterPersisted!, true);
      expect(retriedLater.runReceipt.receiptId).not.toBe(later.runReceipt.receiptId);
      expect(parseCronScheduledRunId(retriedLater.runReceipt.receiptId)).toEqual(
        parseCronScheduledRunId(later.runReceipt.receiptId),
      );
      expect(readCronRunRecordsForTests(later.jobId)).toEqual([]);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_mixed_deferred_release");
      await finishCronRunReceiptAsync({
        handle: failed.runReceipt,
        status: "skipped",
        finishedAtMs: startedAt + 1,
      });
      if (retriedLater) {
        await finishCronRunReceiptAsync({
          handle: retriedLater.runReceipt,
          status: "skipped",
          finishedAtMs: startedAt + 1,
        });
        clearCronJobActive(retriedLater.jobId, retriedLater.activeJobMarker);
      }
      for (const run of [completed, failed, later, predecessor, successor]) {
        clearCronJobActive(run.jobId, run.activeJobMarker);
      }
    }
  });

  it("records a non-firing scheduled trigger as a skipped receipt", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:04:59.500Z");
    const job = createDueIsolatedJob({
      id: "scheduled-trigger-not-fired",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt };
    job.trigger = { script: "return false" };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      cronConfig: { triggers: { enabled: true } },
      storePath: store.storePath,
      nowMs: () => dueAt,
      evaluateCronTrigger: vi.fn(async () => ({ kind: "evaluated" as const, fire: false })),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
      )
      .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
    expect(receipt?.status).toBe("skipped");
  });

  it("schedules an unrelated job missing nextRunAtMs after batch finalization", async () => {
    const store = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:00.000Z");
    const completed = createDueIsolatedJob({
      id: "completed-batch-job",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    completed.state.runningAtMs = startedAt;
    const imported = createDueIsolatedJob({
      id: "imported-without-next-run",
      nowMs: startedAt,
      nextRunAtMs: startedAt + 60_000,
    });
    imported.state.nextRunAtMs = undefined;
    await saveCronStore(store.storePath, { version: 1, jobs: [completed, imported] });
    const runReceiptContext = captureOpenClawStateWorkerContext();
    const receipt = claimReceipt(store.storePath, completed, startedAt);
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => startedAt + 1,
      runIsolatedAgentJob: vi.fn(),
    });

    await finalizeCompletedCronRunOutcomes(state, [
      authorOutcome({
        jobId: completed.id,
        job: completed,
        activeJobMarker: markCronJobActive(completed.id),
        runReceipt: receipt,
        runReceiptContext,
        status: "ok",
        startedAt,
        endedAt: startedAt + 1,
      }),
    ]);

    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.find((job) => job.id === imported.id)?.state.nextRunAtMs).toEqual(
      expect.any(Number),
    );
  });

  it("publishes the committed outcome before best-effort maintenance fails", async () => {
    const store = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:01.000Z");
    const completed = createDueIsolatedJob({
      id: "published-before-maintenance",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    completed.state.runningAtMs = startedAt;
    const sibling = createDueIsolatedJob({
      id: "maintenance-write-fails",
      nowMs: startedAt,
      nextRunAtMs: startedAt + 60_000,
    });
    sibling.state.nextRunAtMs = undefined;
    await saveCronStore(store.storePath, { version: 1, jobs: [completed, sibling] });
    const runReceiptContext = captureOpenClawStateWorkerContext();
    const receipt = claimReceipt(store.storePath, completed, startedAt);
    const events: Array<{ action: string; jobId: string }> = [];
    const warn = vi.fn();
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      cronEnabled: true,
      storePath: store.storePath,
      log: { ...noopLogger, warn },
      nowMs: () => startedAt + 1,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      onEvent: (event) => events.push(event),
    });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TRIGGER reject_post_finalization_maintenance
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.job_id = '${sibling.id}'
      BEGIN
        SELECT RAISE(ABORT, 'maintenance unavailable');
      END;
    `);

    try {
      await expect(
        finalizeCompletedCronRunOutcomes(state, [
          authorOutcome({
            jobId: completed.id,
            job: completed,
            activeJobMarker: markCronJobActive(completed.id),
            runReceipt: receipt,
            runReceiptContext,
            status: "ok",
            startedAt,
            endedAt: startedAt + 1,
          }),
        ]),
      ).resolves.toHaveLength(1);

      expect(events).toContainEqual(
        expect.objectContaining({ action: "finished", jobId: completed.id }),
      );
      const persistedReceipt = database
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId) as { status: string } | undefined;
      expect(persistedReceipt?.status).toBe("ok");
      expect(warn).toHaveBeenCalledWith(
        { err: expect.stringContaining("maintenance unavailable") },
        "cron: post-finalization schedule maintenance failed",
      );
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_post_finalization_maintenance");
    }
  });
});
