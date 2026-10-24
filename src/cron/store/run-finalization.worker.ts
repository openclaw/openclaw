import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  CRON_ADMISSION_DEFERRED_RECEIPT_ERROR,
  isDeferredCronAdmission,
} from "../service/admission-deferred.js";
import { recomputeSingleJobForMaintenance } from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { applyOutcomeToAuthoritativeJob } from "../service/timer-outcomes.js";
import { recordCronRunInDatabase } from "./run-history.kernel.js";
import { hasCronRunDeliveryStartedInDatabase } from "./run-receipt-delivery.js";
import { finishCronRunReceiptInDatabase } from "./run-receipt-store.js";
import { isCronRunTriggerStateRetiredInDatabase } from "./run-receipt-trigger-state.js";
import { cronRunResultHistory } from "./run-result.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";
import { settleCronStartupBatchInWorker } from "./scheduler-actor.worker.js";

/** Execution, primary delivery, job state, and history finish in one worker transaction. */
export function finalizeCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.finalizeRuns"]["input"],
): CronRuntimeWorkerOperations["cron.finalizeRuns"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const policy = input.snapshot;
      const committed = mutateCronRuntimeRowsInDatabase({
        database: db,
        storeKey: input.storeKey,
        jobIds: new Set(policy.outcomes.map((completed) => completed.jobId)),
        mutate({ jobs, receiptSchema }) {
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
              failureRepairTimeoutMs: policy.failureRepairTimeoutMs,
              log: createCronMutationLogger(outcome.logs),
            },
          };
          for (const [outcomeIndex, completed] of policy.outcomes.entries()) {
            const receipt = completed.runReceipt;
            const admissionDeferred = isDeferredCronAdmission(completed.job, completed);
            const storedJob = jobs.get(completed.jobId);
            const retryAfterRestart =
              completed.interruptedByRestart === true &&
              !completed.request &&
              receipt !== undefined &&
              storedJob !== undefined &&
              receipt.configRevision === resolveCronJobConfigRevision(storedJob) &&
              !hasCronRunDeliveryStartedInDatabase(db, receipt);
            // Retention protects the marker still in storage until this mutation flushes.
            const pendingReceiptId =
              storedJob?.state.runningAtMs === undefined
                ? undefined
                : storedJob.state.runningReceiptId;
            // Finishing may prune a removed job's old receipt and its trigger marker.
            const triggerStateRetired =
              receipt && isCronRunTriggerStateRetiredInDatabase({ database: db, handle: receipt });
            // The conditional write owns terminal idempotency; history and job state
            // commit with it, or all roll back together.
            if (
              receipt &&
              !finishCronRunReceiptInDatabase({
                database: db,
                receiptSchema,
                handle: receipt,
                pendingReceiptId,
                status: completed.interruptedByRestart
                  ? "interrupted"
                  : completed.status === "ok" && completed.triggerEval?.fired === false
                    ? "skipped"
                    : completed.status,
                finishedAtMs: completed.endedAt,
                error: admissionDeferred ? CRON_ADMISSION_DEFERRED_RECEIPT_ERROR : completed.error,
              })
            ) {
              continue;
            }
            const currentJob = completed.activeJobMarker?.jobRemoved ? undefined : storedJob;
            const ownsRunningMarker =
              !receipt ||
              !currentJob?.state.runningReceiptId ||
              currentJob.state.runningReceiptId === receipt.receiptId;
            const job =
              currentJob && ownsRunningMarker ? currentJob : structuredClone(completed.job);
            if (admissionDeferred) {
              if (currentJob && ownsRunningMarker) {
                delete currentJob.state.queuedAtMs;
                delete currentJob.state.runningAtMs;
                delete currentJob.state.runningReceiptId;
                delete currentJob.state.runningScheduleChangeId;
                outcome.upsertedJobs.push(currentJob);
              }
              if (completed.request?.runId) {
                outcome.eventPlans.push({ outcomeIndex, job });
              }
              continue;
            }
            const shouldDelete = applyOutcomeToAuthoritativeJob(
              state,
              job,
              {
                ...completed,
                interruptedByRestart: retryAfterRestart,
              },
              {
                request: completed.request,
                deferredNotifications: currentJob && ownsRunningMarker ? outcome.notifications : [],
                triggerStateRetired,
              },
            );
            if (currentJob && ownsRunningMarker) {
              if (shouldDelete) {
                outcome.removedJobs.push(job);
              } else {
                if (!(completed.request?.preserveCadence && !job.enabled)) {
                  recomputeSingleJobForMaintenance(
                    state,
                    job,
                    {
                      nowMs: policy.nowMs,
                      recomputeExpired: Boolean(completed.request),
                      ...(completed.request?.preserveCadence
                        ? { preserveExpiredPacedNextRunJobId: job.id }
                        : {}),
                      deferredNotifications: outcome.notifications,
                    },
                    { reservations: new Map(), isJobActive: () => false },
                  );
                }
                outcome.upsertedJobs.push(job);
              }
            }
            recordCronRunInDatabase(
              db,
              cronRunResultHistory(input.storeKey, job, completed, policy.defaultAgentId),
            );
            outcome.eventPlans.push({ outcomeIndex, job });
          }
          outcome.changed = outcome.upsertedJobs.length > 0 || outcome.removedJobs.length > 0;
          return {
            deleteJobIds: outcome.removedJobs.map((job) => job.id),
            upsertJobIds: outcome.upsertedJobs.map((job) => job.id),
            value: outcome,
          };
        },
      });
      const settled = settleCronStartupBatchInWorker(database, input.storeKey, policy.nowMs);
      committed.value.upsertedJobs.push(...settled.jobs);
      committed.value.notifications.push(...settled.notifications);
      committed.value.logs.push(...settled.logs);
      committed.value.changed ||= settled.jobs.length > 0;
      return { outcome: committed.value };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-finalization" },
  );
}
