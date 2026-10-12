import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { deleteStaleCronJobFamilyRows } from "./row-codec.js";
import { markCronDeliveryStartedInDatabase } from "./run-receipt-delivery.js";
import {
  CronRunReceiptRevisionError,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

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
      const preparation = input.snapshot;
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
        allowMissingJob: preparation.allowMissingJob,
        resolveAgentId: (job) => resolveCronJobEffectiveAgentId(job, preparation.defaultAgentId),
      });
      return { outcome: {} };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-receipt.mark-delivery-started" },
  );
}

export function finishCronReceiptInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.finishReceipt"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      finishCronRunReceiptInDatabase({
        database: db,
        receiptSchema: prepareCronRunReceiptWriteSchema(db),
        ...input.terminal,
      });
      return { outcome: {} };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-receipt.finish" },
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
