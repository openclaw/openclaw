import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { isDeferredCronAdmission } from "../service/admission-deferred.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { applyOutcomeToAuthoritativeJob } from "../service/timer-outcomes.js";
import {
  assertCronRunReceiptCurrentInDatabase,
  assertCronRunReceiptOwnedInDatabase,
  CronRunReceiptRevisionError,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import { isCronRunTriggerStateRetiredInDatabase } from "./run-receipt-trigger-state.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";

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
          const policy = input.snapshot;
          const committed = mutateCronRuntimeRowsInDatabase({
            database: db,
            storeKey: input.storeKey,
            jobIds: new Set(input.jobIds),
            transactionHooks: {
              afterWrite(receiptDatabase, receiptSchema) {
                for (const { terminal } of input.receipts) {
                  if (!policy.deferredReceiptIds.includes(terminal.handle.receiptId)) {
                    finishCronRunReceiptInDatabase({
                      database: receiptDatabase,
                      receiptSchema,
                      ...terminal,
                    });
                  }
                }
              },
            },
            mutate({ jobs }) {
              const retiredTriggerReceiptIds = new Set<string>();
              for (const { terminal, allowMissingJob, allowUnavailable } of input.receipts) {
                if (!allowUnavailable && isAgentDeletionBlocked(terminal.handle.agentId, {}, db)) {
                  throw new CronRunReceiptRevisionError(
                    terminal.handle.receiptId,
                    "cron agent is unavailable",
                    "owner-unavailable",
                  );
                }
                if (
                  isCronRunTriggerStateRetiredInDatabase({ database: db, handle: terminal.handle })
                ) {
                  retiredTriggerReceiptIds.add(terminal.handle.receiptId);
                }
                if (allowMissingJob) {
                  assertCronRunReceiptOwnedInDatabase({ database: db, handle: terminal.handle });
                } else {
                  assertCronRunReceiptCurrentInDatabase({
                    database: db,
                    handle: terminal.handle,
                    resolveAgentId: (job) =>
                      resolveCronJobEffectiveAgentId(job, policy.defaultAgentId),
                  });
                }
              }
              const outcome: CronRuntimeMutationContracts["cron.finalizeRuns"]["outcome"] = {
                changed: false,
                upsertedJobs: [],
                removedJobs: [],
                eventPlans: [],
                notifications: [],
                logs: [],
              };
              const state: CronJobPolicyContext = {
                deps: {
                  nowMs: () => policy.nowMs,
                  cronConfig: policy.cronConfig,
                  log: createCronMutationLogger(outcome.logs),
                },
              };
              for (const [outcomeIndex, completed] of policy.outcomes.entries()) {
                const job = jobs.get(completed.jobId);
                if (!job || completed.activeJobMarker?.jobRemoved === true) {
                  outcome.eventPlans.push({ outcomeIndex });
                  continue;
                }
                if (isDeferredCronAdmission(completed.job, completed)) {
                  // Unstarted work retains its cadence and buffered input. Only
                  // release the exact receipt checked above for the next attempt.
                  delete job.state.queuedAtMs;
                  delete job.state.runningAtMs;
                  delete job.state.runningReceiptId;
                  delete job.state.runningScheduleChangeId;
                  outcome.upsertedJobs.push(job);
                  continue;
                }
                if (
                  applyOutcomeToAuthoritativeJob(state, job, completed, {
                    request: completed.request,
                    deferredNotifications: outcome.notifications,
                    triggerStateRetired:
                      completed.runReceipt &&
                      retiredTriggerReceiptIds.has(completed.runReceipt.receiptId),
                  })
                ) {
                  outcome.removedJobs.push(job);
                } else {
                  outcome.upsertedJobs.push(job);
                }
                outcome.eventPlans.push({ outcomeIndex, job: structuredClone(job) });
              }
              outcome.changed = outcome.upsertedJobs.length > 0 || outcome.removedJobs.length > 0;
              return {
                deleteJobIds: outcome.removedJobs.map((job) => job.id),
                upsertJobIds: outcome.upsertedJobs.map((job) => job.id),
                value: outcome,
              };
            },
          });
          return { outcome: committed.value };
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
      receiptRevision: {
        receiptId: transactionRefusal.receiptId,
        message: transactionRefusal.message,
        reason: transactionRefusal.reason,
      },
    };
  }
}
