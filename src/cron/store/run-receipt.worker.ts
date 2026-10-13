import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  ensureExecutionOwnerLifecycleBindingSchema,
} from "../../audit/execution-owner-lifecycle-binding-store.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { deleteStaleCronJobFamilyRows } from "./row-codec.js";
import { markCronDeliveryStartedInDatabase } from "./run-receipt-delivery.js";
import type { CronRunReceiptDatabase } from "./run-receipt-read.js";
import { CronRunReceiptRevisionError } from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import type { CronStateWorkerOperations } from "./worker-contract.js";

export function bindCronRunReceiptExecutionInWorker(
  database: OpenClawStateDatabase,
  input: CronStateWorkerOperations["cron.bindReceiptExecution"]["input"],
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const receipt = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<CronRunReceiptDatabase>(db)
          .selectFrom("cron_run_receipts")
          .select("receipt_id")
          .where("receipt_id", "=", input.receiptId),
      );
      if (!receipt) {
        return false;
      }
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
      return { outcome: {} };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-receipt.mark-delivery-started" },
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
