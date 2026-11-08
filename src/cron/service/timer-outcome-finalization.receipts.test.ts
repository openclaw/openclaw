import { describe, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
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
import { advanceCronActiveJobGeneration, markCronJobActive } from "../active-jobs.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import {
  CronJobsStoreChangedError,
  loadCronStore,
  noteCronJobsStoreCommit,
  saveCronStore,
} from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  inspectActiveCronRunReceipt,
  finishCronRunReceiptAsync,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.test-support.js";
import type { CronJob, CronStoredJob } from "../types.js";
import { updateWithPrecondition } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { createCronRunHandle } from "./run-history.js";
import * as runtimeMutation from "./runtime-mutation.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import { authorCronRunCompletion } from "./timer-job-runner.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-finalization-receipts-" });
const runtimeAuthority: NonNullable<CronStoredJob["runtimeAuthority"]> = {
  version: 1,
  runtimeId: "fixture",
  namespace: "fixture.apps",
  payload: { apps: [{ id: "calendar" }] },
};

function claimReceipt(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId ?? "main",
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabaseForTest({
      database: db,
      prepared,
    }),
  );
}

function dueJob(id: string, nowMs: number, nextRunAtMs = nowMs) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs });
}

function createState(storePath: string, nowMs: number) {
  return createCronRegressionState({ storePath, nowMs: () => nowMs, runIsolatedAgentJob: vi.fn() });
}

function receiptStatus(receipt: ReturnType<typeof claimReceipt>) {
  return openOpenClawStateDatabase()
    .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
    .get(receipt.receiptId);
}

function completion(
  job: CronJob,
  startedAt: number,
  endedAt: number,
  runReceipt: ReturnType<typeof claimReceipt>,
  overrides: Partial<Omit<TimedCronRunOutcome, "completionStatus" | "deliveryState">> = {},
) {
  return authorCronRunCompletion(job, {
    jobId: job.id,
    job,
    startedAt,
    endedAt,
    runReceipt,
    activeJobMarker: overrides.activeJobMarker ?? markCronJobActive(job.id),
    runReceiptContext: overrides.runReceiptContext ?? captureOpenClawStateWorkerContext(),
    status: "ok",
    ...overrides,
  });
}

describe("cron outcome receipt finalization", () => {
  it.each([false, true])(
    "only acquires schedule maintenance for a stale sibling (%s)",
    async (repairSibling) => {
      const { storePath } = fixtures.makeStorePath();
      const startedAt = Date.now();
      const job = dueJob("completed-request", startedAt);
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      const sibling: CronJob = {
        ...job,
        id: "sibling",
        state: { nextRunAtMs: startedAt + 60_000 },
      };
      if (repairSibling) {
        delete sibling.state.nextRunAtMs;
      }
      await saveCronStore(storePath, { version: 1, jobs: [job, sibling] });
      const receipt = claimReceipt(storePath, job, startedAt);
      const state = createState(storePath, startedAt + 10);
      const mutations = vi.spyOn(runtimeMutation, "runCronRuntimeMutation");
      await finalizeCompletedCronRunOutcomes(state, [
        completion(job, startedAt, startedAt + 10, receipt, {
          request: { executionJob: job, preserveCadence: false, scheduleOwnershipAtMs: startedAt },
        }),
      ]);
      const stored = await loadCronStore(storePath);
      expect(stored.jobs.map((entry) => entry.state.nextRunAtMs)).toEqual([
        startedAt + 60_000,
        startedAt + 60_000,
      ]);
      expect(receiptStatus(receipt)).toEqual({ status: "ok" });
      expect(
        mutations.mock.calls.filter(([params]) => params.type === "cron.scheduleUnowned"),
      ).toHaveLength(repairSibling ? 1 : 0);
    },
  );

  it.each([
    { classification: undefined, reason: "timeout", errors: 3 },
    { classification: { kind: "permanent" }, reason: undefined, errors: 3 },
    { classification: { kind: "aborted" }, reason: undefined, errors: 2 },
    { classification: { kind: "reason", reason: "rate_limit" }, reason: "rate_limit", errors: 3 },
  ] as const)(
    "records host classification $classification with the receipt and job outcome",
    async ({ classification, reason, errors }) => {
      const { storePath } = fixtures.makeStorePath();
      const startedAt = Date.now();
      const job = dueJob("classified-outcome", startedAt);
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      job.state.consecutiveErrors = 2;
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const receipt = claimReceipt(storePath, job, startedAt);
      const state = createState(storePath, startedAt + 10);
      await finalizeCompletedCronRunOutcomes(state, [
        completion(job, startedAt, startedAt + 10, receipt, {
          status: "error",
          error: "internal_error from provider",
          provider: "anthropic",
          errorClassification: classification,
        }),
      ]);
      const stored = (await loadCronStore(storePath)).jobs[0]!;
      expect(stored.state.lastErrorReason).toBe(reason);
      expect(stored.state.consecutiveErrors).toBe(errors);
      expect(receiptStatus(receipt)).toEqual({ status: "error" });
      const history = readCronRunHistoryPageForTests({
        storeKey: cronStoreKey(storePath),
        jobId: job.id,
      });
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]?.errorReason).toBe(reason);
    },
  );

  it.each(["current", "legacy definition", "legacy state"])(
    "accepts the first guarded update after publishing a completed run (%s)",
    async (shape) => {
      const { storePath } = fixtures.makeStorePath();
      const startedAt = Date.now();
      const job: CronStoredJob = dueJob("guarded-completed-run", startedAt);
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      job.runtimeAuthority = structuredClone(runtimeAuthority);
      job.state.runningAtMs = startedAt;
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      if (shape === "legacy definition") {
        // Runtime settlement preserves legacy definitions rather than inserting defaults.
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.enabled') WHERE store_key = ? AND job_id = ?",
          )
          .run(cronStoreKey(storePath), job.id);
      }
      const runReceipt = claimReceipt(storePath, job, startedAt);
      const state = createState(storePath, startedAt + 10);
      state.schedulerStarted = true;
      await list(state);
      await finalizeCompletedCronRunOutcomes(state, [
        completion(job, startedAt, startedAt + 10, runReceipt),
      ]);
      const completed = (await loadCronStore(storePath)).jobs[0]!;
      expect(completed.state).toMatchObject({
        lastRunStatus: "ok",
        lastRunAtMs: startedAt,
        lastDurationMs: 10,
      });
      if (shape === "legacy state") {
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE cron_jobs SET state_json = json_remove(state_json, '$.lastRunStatus') WHERE store_key = ? AND job_id = ?",
          )
          .run(cronStoreKey(storePath), job.id);
        noteCronJobsStoreCommit(storePath);
      }
      const precondition = vi.fn((current: CronJob) => {
        expect(current.enabled).toBe(shape === "legacy definition" ? undefined : true);
        if (shape === "legacy state") {
          expect(current.state.lastRunStatus).toBeUndefined();
          expect(current.state.lastStatus).toBe("ok");
        }
      });

      await updateWithPrecondition(state, job.id, { enabled: false }, precondition);

      expect(precondition).toHaveBeenCalledOnce();
      expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
        enabled: false,
        runtimeAuthority: job.runtimeAuthority,
        state: {
          lastRunStatus: "ok",
          lastRunAtMs: startedAt,
          lastDurationMs: 10,
        },
      });
    },
  );

  it.each(["definition", "authority", "run identity"] as const)(
    "rejects a guarded update when the observed %s changes",
    async (change) => {
      const { storePath } = fixtures.makeStorePath();
      const now = Date.now();
      const job: CronStoredJob = dueJob("guarded-change", now);
      job.state.runningAtMs = now;
      job.state.runningReceiptId = "observed-run";
      job.runtimeAuthority = structuredClone(runtimeAuthority);
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const state = createState(storePath, now);
      const precondition = vi.fn(async () => {
        const current = await loadCronStore(storePath);
        const changed = current.jobs[0]!;
        if (change === "definition") {
          changed.name = "changed by another writer";
        } else if (change === "authority") {
          delete changed.runtimeAuthority;
          changed.runtimeAuthorityRecoveryRequired = true;
        } else {
          changed.state.runningReceiptId = "replacement-run";
        }
        await saveCronStore(storePath, current);
      });

      await expect(
        updateWithPrecondition(state, job.id, { enabled: false }, precondition),
      ).rejects.toBeInstanceOf(CronJobsStoreChangedError);

      expect(precondition).toHaveBeenCalledOnce();
      const retained = (await loadCronStore(storePath)).jobs[0]!;
      expect(retained.enabled).toBe(true);
      if (change === "definition") {
        expect(retained.name).toBe("changed by another writer");
      } else if (change === "authority") {
        expect(retained.runtimeAuthority).toBeUndefined();
        expect(retained.runtimeAuthorityRecoveryRequired).toBe(true);
      } else {
        expect(retained.state.runningReceiptId).toBe("replacement-run");
      }
    },
  );

  it("refreshes the public job view after a committed terminal reply is lost", async () => {
    const { storePath } = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:00.000Z");
    const job = dueJob("lost-terminal-reply", startedAt);
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
    job.state.runningAtMs = startedAt;
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const runReceipt = claimReceipt(storePath, job, startedAt);
    const state = createState(storePath, startedAt + 1);
    state.schedulerStarted = true;
    expect((await list(state))[0]?.state.runningAtMs).toBe(startedAt);
    const dropped = loseFirstCronMutationReply("cron.finalizeRuns");
    try {
      await expect(
        finalizeCompletedCronRunOutcomes(state, [
          completion(job, startedAt, startedAt + 1, runReceipt),
        ]),
      ).rejects.toThrow();
      expect(dropped.wasDropped()).toBe(true);
      await dropped.waitForExit();
      expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
      const visible = (await list(state))[0];
      expect(visible?.state.lastRunStatus).toBe("ok");
      expect(visible?.state.runningAtMs).toBeUndefined();
    } finally {
      await dropped.close();
    }
  });

  it.each([false, true])(
    "preserves authored rows while finalizing a retired outcome without consuming a same-millisecond successor (replaced=%s)",
    async (replaced) => {
      const store = fixtures.makeStorePath();
      const startedAt = Date.now();
      const retired = dueJob("retired-batch", startedAt);
      const current = dueJob("current-batch", startedAt);
      retired.state.runningAtMs = startedAt;
      current.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      current.state.runningAtMs = startedAt;
      await saveCronStore(store.storePath, { version: 1, jobs: [retired, current] });
      const runReceiptContext = captureOpenClawStateWorkerContext();
      const retiredReceipt = claimReceipt(store.storePath, retired, startedAt);
      const currentReceipt = claimReceipt(store.storePath, current, startedAt);
      const state = createState(store.storePath, startedAt);
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
          completion(retired, startedAt, startedAt, retiredReceipt, {
            taskRunId,
            activeJobMarker: retiredMarker,
            runReceiptContext,
          }),
          completion(current, startedAt, startedAt, currentReceipt, {
            activeJobMarker: currentMarker,
            runReceiptContext,
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
        expect(receiptStatus(currentReceipt)).toEqual({ status: "ok" });
        expect(receiptStatus(retiredReceipt)).toEqual({ status: replaced ? "superseded" : "ok" });
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
    const stale = dueJob("rejected-event", startedAt);
    const current = dueJob("committed-event", startedAt);
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
      completion(stale, startedAt, startedAt + 2, staleReceipt, { runReceiptContext }),
      completion(current, startedAt, startedAt + 2, currentReceipt, { runReceiptContext }),
    ]);

    expect(events.filter((event) => event.action === "finished")).toEqual([
      expect.objectContaining({
        jobId: current.id,
        job: expect.objectContaining({ name: "authoritative edited name" }),
      }),
    ]);
  });

  it("schedules an unrelated job missing nextRunAtMs after batch finalization", async () => {
    const store = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:00.000Z");
    const completed = dueJob("completed-batch-job", startedAt);
    completed.state.runningAtMs = startedAt;
    const imported = dueJob("imported-without-next-run", startedAt, startedAt + 60_000);
    imported.state.nextRunAtMs = undefined;
    await saveCronStore(store.storePath, { version: 1, jobs: [completed, imported] });
    const runReceiptContext = captureOpenClawStateWorkerContext();
    const receipt = claimReceipt(store.storePath, completed, startedAt);
    const state = createState(store.storePath, startedAt + 1);

    expect(state.store).toBeNull();
    await finalizeCompletedCronRunOutcomes(state, [
      completion(completed, startedAt, startedAt + 1, receipt, { runReceiptContext }),
    ]);

    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.find((job) => job.id === imported.id)?.state.nextRunAtMs).toEqual(
      expect.any(Number),
    );
  });

  it("publishes the committed outcome before best-effort maintenance fails", async () => {
    const store = fixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:01.000Z");
    const completed = dueJob("published-before-maintenance", startedAt);
    completed.state.runningAtMs = startedAt;
    const sibling = dueJob("maintenance-write-fails", startedAt, startedAt + 60_000);
    sibling.state.nextRunAtMs = undefined;
    await saveCronStore(store.storePath, { version: 1, jobs: [completed, sibling] });
    const runReceiptContext = captureOpenClawStateWorkerContext();
    const receipt = claimReceipt(store.storePath, completed, startedAt);
    const events: Array<{ action: string; jobId: string }> = [];
    const warn = vi.fn();
    const state = createCronRegressionState({
      storePath: store.storePath,
      log: { ...noopLogger, warn },
      nowMs: () => startedAt + 1,
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
          completion(completed, startedAt, startedAt + 1, receipt, { runReceiptContext }),
        ]),
      ).resolves.toHaveLength(1);

      expect(events).toContainEqual(
        expect.objectContaining({ action: "finished", jobId: completed.id }),
      );
      expect(receiptStatus(receipt)).toEqual({ status: "ok" });
      expect(warn).toHaveBeenCalledWith(
        { err: expect.stringContaining("maintenance unavailable") },
        "cron: post-finalization schedule maintenance failed",
      );
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_post_finalization_maintenance");
    }
  });
});
