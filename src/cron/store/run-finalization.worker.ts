import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolvePreparedCronFailureAlert } from "../service/failure-alerts.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { applyOutcomeToAuthoritativeJob } from "../service/timer-outcomes.js";
import { deleteCronJobRowInDatabase, updateCronRuntimeRow } from "./row-codec.js";
import { loadRuntimeRows } from "./run-admission.worker.js";
import {
  assertCronRunReceiptCurrentInDatabase,
  assertCronRunReceiptOwnedInDatabase,
  finishCronRunReceiptInDatabase,
  CronRunReceiptRevisionError,
} from "./run-receipt-store.js";
import { isCronRunTriggerStateRetiredInDatabase } from "./run-receipt-trigger-state.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import {
  admitCronRuntimeMutation,
  createCronMutationLogger,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

/** Job state and its terminal receipt share the same authoritative write transaction. */
export function finalizeCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.finalizeRuns"]["input"],
): CronRuntimeWorkerOperations["cron.finalizeRuns"]["output"] {
  let transactionRefusal: CronRunReceiptRevisionError | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        try {
          const { jobs } = loadRuntimeRows(db, input.storeKey, input.jobIds);
          const receiptSchema = prepareCronRunReceiptWriteSchema(db);
          const preparation = input.prepared;
          admitCronRuntimeMutation(input.nonce);
          for (const { terminal, allowMissingJob, disposition } of input.receipts) {
            if (
              isAgentDeletionBlocked(terminal.handle.agentId, {}, db) &&
              !(terminal.status === "error" && disposition === "owner-unavailable")
            ) {
              throw new CronRunReceiptRevisionError(
                terminal.handle.receiptId,
                describeUnavailableCronAgent(terminal.handle.agentId),
                "owner-unavailable",
              );
            }
            if (allowMissingJob) {
              assertCronRunReceiptOwnedInDatabase({ database: db, handle: terminal.handle });
            } else {
              assertCronRunReceiptCurrentInDatabase({
                database: db,
                handle: terminal.handle,
                resolveAgentId: (job) =>
                  resolveCronJobEffectiveAgentId(job, preparation.defaultAgentId),
              });
            }
          }
          const outcome: CronRuntimeMutationContracts["cron.finalizeRuns"]["outcome"] = {
            changed: false,
            upsertedJobs: [],
            removedJobs: [],
            eventJobs: [],
            notifications: [],
            logs: [],
          };
          const state: CronJobPolicyContext = {
            deps: {
              nowMs: () => preparation.nowMs,
              cronConfig: preparation.cronConfig,
              log: createCronMutationLogger(outcome.logs),
            },
          };
          for (const result of preparation.outcomes) {
            const job = jobs.get(result.jobId);
            if (!job || result.activeJobMarker?.jobRemoved) {
              outcome.eventJobs.push(undefined);
              continue;
            }
            state.preparedFailureAlert = {
              jobId: job.id,
              value: resolvePreparedCronFailureAlert(preparation.failureAlerts, job.id, job),
            };
            const previousEnabled = job.enabled ?? true;
            const removed = applyOutcomeToAuthoritativeJob(state, job, result, {
              request: result.request,
              deferredNotifications: outcome.notifications,
              triggerStateRetired: result.runReceipt
                ? isCronRunTriggerStateRetiredInDatabase({
                    database: db,
                    handle: result.runReceipt,
                  })
                : false,
            });
            if (removed) {
              deleteCronJobRowInDatabase(db, input.storeKey, job.id);
              outcome.removedJobs.push(job);
            } else {
              updateCronRuntimeRow(db, input.storeKey, job, previousEnabled);
              outcome.upsertedJobs.push(job);
            }
            outcome.changed = true;
            outcome.eventJobs.push(structuredClone(job));
          }
          for (const { terminal } of input.receipts) {
            if (!preparation.deferredReceiptIds.includes(terminal.handle.receiptId)) {
              finishCronRunReceiptInDatabase({ database: db, receiptSchema, ...terminal });
            }
          }
          return retainCronRuntimeMutationOutcome("cron.finalizeRuns", db, input.nonce, outcome);
        } catch (error) {
          if (error instanceof CronRunReceiptRevisionError) {
            transactionRefusal = error;
          }
          throw error;
        }
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "cron.run-finalization" },
    );
  } catch (error) {
    if (!transactionRefusal || error !== transactionRefusal) {
      throw error;
    }
    assertTransactionUsable(database.db);
    if (!database.db.isOpen || database.db.isTransaction) {
      throw error;
    }
    // Preserve domain identity only after rollback, never through an uncertain write failure.
    return {
      nonce: input.nonce,
      receiptRevision: {
        receiptId: transactionRefusal.receiptId,
        message: transactionRefusal.message,
        reason: transactionRefusal.reason,
      },
    };
  }
}
