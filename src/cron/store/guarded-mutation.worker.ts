import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { findCronRunRecoveryInDatabase } from "../service/run-history-recovery.js";
import { readCronJobNamesInDatabase } from "./job-name.kernel.js";
import {
  deleteCronJobRowInDatabase,
  fingerprintCronJobRows,
  fingerprintCronRuntimeRows,
  loadedCronStoreFromRows,
  loadCronRows,
} from "./row-codec.js";
import {
  adjudicateActiveCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  findActiveCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import { retireCronRunTriggerStateInDatabase } from "./run-receipt-trigger-state.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { loadCronRuntimeAuthorities } from "./runtime-authority-store.js";
import {
  prepareCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import { CronJobsStoreChangedError } from "./save-error.js";
import {
  assertCronStoreChangesCurrent,
  saveCronStoreChangesInDatabase,
  saveCronStoreInDatabase,
} from "./save.kernel.js";
import type { CronAdmittedStoreTransactionHooks } from "./transaction-hooks.types.js";

type MutationInput = CronRuntimeWorkerOperations["cron.mutateJobs"]["input"];

function loadCronMutationStore(db: DatabaseSync, storeKey: string) {
  const rows = loadCronRows(db, storeKey);
  const store = loadedCronStoreFromRows(rows).store;
  loadCronRuntimeAuthorities({ db, storeKey, jobs: store.jobs });
  return {
    store,
    jobsFingerprint: fingerprintCronJobRows(rows),
    runtimeFingerprint: fingerprintCronRuntimeRows(rows),
  };
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

function applyCronReceiptMutation(db: DatabaseSync, input: MutationInput, nowMs: number): void {
  const mutation = input.receiptMutation;
  if (!mutation) {
    return;
  }
  if (mutation.scheduleChanged) {
    const nextJob = input.replacement
      ? input.replacement.store.jobs.find((job) => job.id === mutation.jobId)
      : input.changes.nextById.get(mutation.jobId);
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
  if (mutation.owner) {
    adjudicateActiveCronRunReceiptInDatabase({
      database: db,
      jobId: mutation.jobId,
      prepared: mutation.owner,
      finishedAtMs: nowMs,
    });
  }
}

export function mutateCronJobsInWorker(
  database: OpenClawStateDatabase,
  input: MutationInput,
): CronRuntimeWorkerOperations["cron.mutateJobs"]["output"] {
  let transactionRefusal: CronJobsStoreChangedError | CronRunReceiptConflictError | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        try {
          const receiptSchema = prepareCronRunReceiptWriteSchema(db);
          const preparation = prepareCronRuntimeMutation("cron.mutateJobs", input.nonce, {
            deletionBlocked:
              input.agentId !== undefined && isAgentDeletionBlocked(input.agentId, {}, db),
          });
          if (input.preconditionJob || input.expectedJob || input.replacement) {
            const current = loadCronMutationStore(db, input.storeKey);
            if (
              input.replacement &&
              (current.jobsFingerprint !== input.replacement.jobsFingerprint ||
                current.runtimeFingerprint !== input.replacement.runtimeFingerprint)
            ) {
              throw new CronJobsStoreChangedError(input.storeKey);
            }
            const currentById = new Map(current.store.jobs.map((job) => [job.id, job]));
            const expected = input.expectedJob;
            const expectedCurrent = expected ? currentById.get(expected.id) : undefined;
            if (
              expected &&
              (!expectedCurrent ||
                resolveCronJobConfigRevision(expectedCurrent) !== expected.configRevision)
            ) {
              throw new CronJobsStoreChangedError(input.storeKey);
            }
            // Transport removes null prototypes from the immutable authority envelope.
            // Compare the same representation without rerunning an effectful host precondition.
            if (
              input.preconditionJob &&
              !isDeepStrictEqual(
                structuredClone(currentById.get(input.preconditionJob.id)),
                input.preconditionJob,
              )
            ) {
              throw new CronJobsStoreChangedError(input.storeKey);
            }
            if (input.replacement) {
              // Definition fingerprints exclude the independently revocable authority sidecar.
              for (const [jobId, previous] of input.changes.previousById) {
                const currentJob = currentById.get(jobId);
                if (
                  !isDeepStrictEqual(
                    structuredClone(currentJob?.runtimeAuthority),
                    previous.runtimeAuthority,
                  ) ||
                  (currentJob?.runtimeAuthorityRecoveryRequired === true) !==
                    (previous.runtimeAuthorityRecoveryRequired === true)
                ) {
                  throw new CronJobsStoreChangedError(input.storeKey);
                }
              }
              assertCronStoreChangesCurrent(input.changes, currentById, input.storeKey);
            }
          }
          const hooks: CronAdmittedStoreTransactionHooks = {
            receiptSchema,
            hooks: {
              beforeWrite: () => {
                applyCronReceiptMutation(db, input, preparation.nowMs);
              },
            },
          };
          if (input.replacement) {
            for (const jobId of input.changes.changedIds) {
              if (!input.changes.nextById.has(jobId)) {
                deleteCronJobRowInDatabase(db, input.storeKey, jobId);
              }
            }
            saveCronStoreInDatabase(
              database,
              input.storeKey,
              input.replacement.store,
              input.replacement.options,
              hooks,
            );
          } else {
            saveCronStoreChangesInDatabase(
              db,
              input.storeKey,
              input.storeKey,
              input.changes,
              undefined,
              hooks,
            );
          }
          const outcome = {
            ...loadCronMutationStore(db, input.storeKey),
            names: readCronJobNamesInDatabase(db, undefined, input.storeKey),
          };
          return retainCronRuntimeMutationOutcome("cron.mutateJobs", db, input.nonce, outcome);
        } catch (error) {
          if (
            error instanceof CronJobsStoreChangedError ||
            error instanceof CronRunReceiptConflictError
          ) {
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
      nonce: input.nonce,
      mutationRefusal:
        transactionRefusal instanceof CronRunReceiptConflictError
          ? { kind: "receipt-conflict", receipt: transactionRefusal.receipt }
          : { kind: "store-changed" },
    };
  }
}
