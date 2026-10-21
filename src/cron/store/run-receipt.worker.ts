import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  ensureExecutionOwnerLifecycleBindingSchema,
} from "../../audit/execution-owner-lifecycle-binding-store.js";
import { findDeliveryIntentOwnersInDatabase } from "../../infra/outbound/delivery-queue-ownership.kernel.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { deleteStaleCronJobFamilyRows } from "./row-codec.js";
import { markCronDeliveryStartedInDatabase } from "./run-receipt-delivery.js";
import { CronRunReceiptRevisionError } from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeWorkerOperations,
} from "./runtime-worker.types.js";
import type { CronStateWorkerOperations } from "./worker-contract.js";

export function bindCronRunReceiptExecutionInWorker(
  database: OpenClawStateDatabase,
  input: CronStateWorkerOperations["cron.bindReceiptExecution"]["input"],
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // A callback delayed past receipt pruning may leave an orphan diagnostic link;
      // this metadata never grants execution or delivery authority.
      if (!prepareCronRunReceiptWriteSchema(db).executionOwnerLifecycleBindings) {
        ensureExecutionOwnerLifecycleBindingSchema(db);
      }
      return (
        bindExecutionOwnerLifecycleMetadata({
          db,
          ownerKind: "cron",
          ownerId: input.receiptId,
          binding: input.binding,
        }) !== "mismatch"
      );
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-receipt.execution-binding" },
  );
}

export function markCronDeliveryStartedInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.markDeliveryStarted"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (input.storeKey !== input.handle.storeKey) {
        throw new CronRunReceiptRevisionError(input.handle.receiptId);
      }
      const deletionBlocked = isAgentDeletionBlocked(input.handle.agentId, {}, db);
      if (deletionBlocked) {
        throw new CronRunReceiptRevisionError(
          input.handle.receiptId,
          "cron agent is unavailable",
          "owner-unavailable",
        );
      }
      markCronDeliveryStartedInDatabase({
        database: db,
        handle: input.handle,
      });
      const admission = input.deliveryAdmission;
      if (!admission) {
        return { outcome: {} };
      }
      // The admission commits with the attempt fact, before the outbound queue
      // takes custody. Only the job's live run writes it; a run that removed its
      // own one-shot has no row to carry it.
      const committed = mutateCronRuntimeRowsInDatabase<
        CronRuntimeMutationContracts["cron.markDeliveryStarted"]["outcome"]
      >({
        database: db,
        storeKey: input.storeKey,
        jobIds: new Set([input.handle.jobId]),
        mutate({ jobs }) {
          const job = jobs.get(input.handle.jobId);
          if (job?.state.runningReceiptId !== input.handle.receiptId) {
            return { value: {} };
          }
          job.state.deliveryAdmission = { ...admission };
          return { upsertJobIds: [job.id], value: { job } };
        },
      });
      return { outcome: committed.value };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-receipt.mark-delivery-started" },
  );
}

/**
 * Withdraws an admission whose send its run proved never started. The stored
 * admission, the queue's lack of custody, and the absence of any later run
 * authorize it, so abort cleanup that outlives the run can still settle it.
 */
export function releaseCronDeliveryAdmissionInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.releaseDeliveryAdmission"]["input"],
): CronRuntimeWorkerOperations["cron.releaseDeliveryAdmission"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const committed = mutateCronRuntimeRowsInDatabase<
        CronRuntimeMutationContracts["cron.releaseDeliveryAdmission"]["outcome"]
      >({
        database: db,
        storeKey: input.storeKey,
        jobIds: new Set([input.handle.jobId]),
        mutate({ jobs }) {
          const job = jobs.get(input.handle.jobId);
          const current = job?.state.deliveryAdmission;
          // A run that started after this one read the admission when it activated;
          // releasing now could let it and a later retry both send the occurrence.
          const laterRunStarted =
            (job?.state.runningAtMs !== undefined &&
              job.state.runningReceiptId !== input.handle.receiptId) ||
            (job?.state.lastRunAtMs ?? 0) > input.handle.startedAtMs;
          if (
            !job ||
            current?.occurrenceAtMs !== input.admission.occurrenceAtMs ||
            current.intentId !== input.admission.intentId ||
            laterRunStarted ||
            findDeliveryIntentOwnersInDatabase(database, { ids: [input.admission.intentId] })[0] !==
              null
          ) {
            return { value: {} };
          }
          delete job.state.deliveryAdmission;
          return { upsertJobIds: [job.id], value: { job } };
        },
      });
      return { outcome: committed.value };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.release-delivery-admission" },
  );
}

export function removeStaleCronFamilyInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.removeStaleFamily"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const removed = deleteStaleCronJobFamilyRows(db, input.storeKey, input.family);
      return { outcome: { removed } };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.job-family-adoption" },
  );
}
