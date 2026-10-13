import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { CronAgentDeletionBlockedError } from "../agent-availability.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { findCronRunRecoveryInDatabase } from "../service/run-history-recovery.js";
import { planCronJobMutation, resolveCronJobMutationSnapshot } from "./job-mutations.worker.js";
import { readCronJobNamesInDatabase } from "./job-name.kernel.js";
import { loadedCronStoreFromRows, loadCronRows, updateCronRuntimeRow } from "./row-codec.js";
import { recordSkippedCronRequestInDatabase } from "./run-history.kernel.js";
import {
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import { retireCronRunTriggerStateInDatabase } from "./run-receipt-trigger-state.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { loadCronRuntimeAuthorities } from "./runtime-authority-store.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import { CronJobsStoreChangedError } from "./save-error.js";
import { saveCronStoreChangesInDatabase, prepareCronStoreChanges } from "./save.kernel.js";
import type { PreparedCronStoreChanges } from "./save.types.js";
import type { CronAdmittedStoreTransactionHooks } from "./transaction-hooks.types.js";

type MutationInput = CronRuntimeWorkerOperations["cron.mutateJobs"]["input"];

function loadCronMutationStore(db: DatabaseSync, storeKey: string) {
  const rows = loadCronRows(db, storeKey);
  const store = loadedCronStoreFromRows(rows).store;
  loadCronRuntimeAuthorities({ db, storeKey, jobs: store.jobs });
  return store;
}

function retireCronMutationTriggerState(db: DatabaseSync, storeKey: string, jobId: string): void {
  const active = findActiveCronRunReceiptInDatabase({ database: db, storePath: storeKey, jobId });
  if (active) {
    retireCronRunTriggerStateInDatabase({ database: db, handle: active });
    return;
  }
  const job = loadedCronStoreFromRows(loadCronRows(db, storeKey, new Set([jobId]))).store.jobs[0];
  const startedAtMs = job?.state.runningAtMs;
  if (!job || startedAtMs === undefined) {
    return;
  }
  // Legacy running markers have no receipt association; history retains that identity.
  const receiptId =
    job.state.runningReceiptId ??
    findCronRunRecoveryInDatabase({ database: db, jobId, storeKey, startedAt: startedAtMs })
      .receiptId;
  if (receiptId) {
    retireCronRunTriggerStateInDatabase({
      database: db,
      handle: { receiptId, storeKey, jobId, startedAtMs },
    });
  }
}

function applyCronReceiptMutation(
  db: DatabaseSync,
  input: MutationInput,
  changes: PreparedCronStoreChanges,
): void {
  const mutation = input.receiptMutation;
  if (!mutation) {
    return;
  }
  if (mutation.scheduleChanged) {
    const nextJob = changes.nextById.get(mutation.jobId);
    if (!nextJob) {
      throw new Error("Cron schedule mutation has no target job");
    }
    const current = loadedCronStoreFromRows(
      loadCronRows(db, input.storeKey, new Set([mutation.jobId])),
    ).store.jobs[0];
    if (current?.state.runningAtMs !== undefined) {
      // Each committed edit must remain distinct when a passive editor observed an older run.
      nextJob.state.runningScheduleChangeId = randomUUID();
    } else {
      delete nextJob.state.runningScheduleChangeId;
    }
  }
  if (mutation.triggerStateChanged) {
    retireCronMutationTriggerState(db, input.storeKey, mutation.jobId);
  }
}

function cancelChangedQueuedRuns(
  db: DatabaseSync,
  input: MutationInput,
  changes: PreparedCronStoreChanges,
  previousJobs: ReturnType<typeof loadCronMutationStore>["jobs"],
  receiptSchema: ReturnType<typeof prepareCronRunReceiptWriteSchema>,
): void {
  const currentJobs = new Map(
    loadCronMutationStore(db, input.storeKey).jobs.map((job) => [job.id, job]),
  );
  for (const previous of previousJobs) {
    if (previous.state.queuedAtMs === undefined || !changes.changedIds.has(previous.id)) {
      continue;
    }
    const current = currentJobs.get(previous.id);
    // Re-arming an already consumed exit watch leaves its accepted event intact.
    const rearmedExit =
      current &&
      previous.schedule.kind === "on-exit" &&
      !previous.enabled &&
      current.enabled &&
      cronSchedulingInputsEqual({ ...previous, enabled: true }, current);
    if (current && (cronSchedulingInputsEqual(previous, current) || rearmedExit)) {
      continue;
    }
    const receipt = findActiveCronRunReceiptInDatabase({
      database: db,
      storePath: input.storeKey,
      jobId: previous.id,
    });
    const error = current
      ? "cron: queued job schedule changed or was disabled"
      : "cron: queued job was removed";
    if (receipt && receipt.startedAtMs === previous.state.queuedAtMs) {
      finishCronRunReceiptInDatabase({
        database: db,
        receiptSchema,
        handle: receipt,
        pendingReceiptId:
          current?.state.runningAtMs === undefined ? undefined : current.state.runningReceiptId,
        status: "skipped",
        finishedAtMs: input.snapshot.nowMs,
        error,
      });
      recordSkippedCronRequestInDatabase(db, {
        storeKey: input.storeKey,
        jobId: receipt.jobId,
        receiptId: receipt.receiptId,
        agentId: receipt.agentId,
        startedAt: receipt.startedAtMs,
        endedAt: input.snapshot.nowMs,
        error,
        nextRunAtMs: current?.state.nextRunAtMs,
      });
    }
    if (current?.state.queuedAtMs === previous.state.queuedAtMs) {
      delete current.state.queuedAtMs;
      updateCronRuntimeRow(db, input.storeKey, current);
    }
  }
}

export function mutateCronJobsInWorker(
  database: OpenClawStateDatabase,
  input: MutationInput,
): CronRuntimeWorkerOperations["cron.mutateJobs"]["output"] {
  const mutationSnapshot = resolveCronJobMutationSnapshot(
    input.storeKey,
    input.snapshot,
    database.path,
  );
  let transactionRefusal: CronJobsStoreChangedError | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        try {
          const receiptSchema = prepareCronRunReceiptWriteSchema(db);
          const previous = loadCronMutationStore(db, input.storeKey);
          if (input.agentId !== undefined && isAgentDeletionBlocked(input.agentId, {}, db)) {
            throw new CronAgentDeletionBlockedError(input.agentId);
          }
          const expected = input.expectedJob;
          const expectedCurrent = expected
            ? previous.jobs.find((job) => job.id === expected.id)
            : undefined;
          if (
            expected &&
            (!expectedCurrent ||
              resolveCronJobConfigRevision(expectedCurrent) !== expected.configRevision)
          ) {
            throw new CronJobsStoreChangedError(input.storeKey);
          }
          // Compare the transported representation without rerunning an effectful host precondition.
          if (
            input.preconditionJob &&
            !isDeepStrictEqual(
              structuredClone(previous.jobs.find((job) => job.id === input.preconditionJob?.id)),
              input.preconditionJob,
            )
          ) {
            throw new CronJobsStoreChangedError(input.storeKey);
          }
          const plan = planCronJobMutation(previous, input.jobMutation, mutationSnapshot);
          const changes = prepareCronStoreChanges(previous, plan.next);
          const hooks: CronAdmittedStoreTransactionHooks = {
            receiptSchema,
            hooks: {
              beforeWrite: () => {
                applyCronReceiptMutation(db, input, changes);
              },
            },
          };
          saveCronStoreChangesInDatabase(
            db,
            input.storeKey,
            input.storeKey,
            changes,
            undefined,
            hooks,
          );
          cancelChangedQueuedRuns(db, input, changes, previous.jobs, receiptSchema);
          return {
            outcome: {
              store: loadCronMutationStore(db, input.storeKey),
              names: readCronJobNamesInDatabase(db, undefined, input.storeKey),
              changed: changes.changedIds.size > 0,
              notifications: plan.notifications,
              logs: plan.logs,
            },
          };
        } catch (error) {
          if (error instanceof CronJobsStoreChangedError) {
            transactionRefusal = error;
          }
          throw error;
        }
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "cron.config-mutation" },
    );
  } catch (error) {
    if (!transactionRefusal || error !== transactionRefusal) {
      throw error;
    }
    assertTransactionUsable(database.db);
    if (!database.db.isOpen || database.db.isTransaction) {
      throw error;
    }
    // Typed refusal is safe only after rollback; uncertain commits retain generic failure.
    return {
      mutationRefusal: { kind: "store-changed" },
    };
  }
}
