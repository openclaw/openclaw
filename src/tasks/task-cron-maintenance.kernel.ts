import type { DatabaseSync } from "node:sqlite";
import {
  prepareCronTaskMaintenance,
  type CronTaskMaintenanceInput,
} from "./task-cron-maintenance-policy.js";
import {
  bindTaskRecord,
  listTaskRecordsByRuntimeSourceIdInDatabase,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";

/** Recovery and loss share writer custody so a durable outcome cannot land between them. */
export function maintainCronTaskInDatabase(
  db: DatabaseSync,
  input: CronTaskMaintenanceInput,
  assertCurrent: () => void,
) {
  const current = readTaskRecord(db, input.taskId);
  const jobId = current?.sourceId?.trim();
  const rows = jobId ? listTaskRecordsByRuntimeSourceIdInDatabase(db, "cron", jobId) : [];
  const receipt = prepareCronTaskMaintenance(current, rows, input);
  if (!receipt) {
    return null;
  }
  assertCurrent();
  if (receipt.persisted) {
    upsertTaskRunRowInDatabase({ db }, bindTaskRecord(receipt.task));
  }
  return receipt;
}
