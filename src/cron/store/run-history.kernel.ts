import type { DatabaseSync } from "node:sqlite";
import { cronRunRecordFromTask } from "../../tasks/cron-task-record.js";
import { listTaskRecordsByRuntimeSourceIdInDatabase } from "../../tasks/task-registry.store.kernel.js";
import type { CronRunRecord } from "./run-history.types.js";

/** Tasks still owns row validation and lifecycle normalization until its runtime retires. */
export function readCronRunRecordsInDatabase(db: DatabaseSync, jobId?: string): CronRunRecord[] {
  return listTaskRecordsByRuntimeSourceIdInDatabase(db, "cron", jobId).map(cronRunRecordFromTask);
}
