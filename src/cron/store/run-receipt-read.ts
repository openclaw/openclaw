import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import type {
  CronRunReceipt,
  CronRunReceiptHandle,
  CronRunReceiptRecoveryCandidate,
  CronRunReceiptStatus,
} from "./run-receipt.types.js";

export type CronRunReceiptDatabase = Pick<OpenClawStateDatabase, "cron_run_receipts">;
export type CronRunReceiptRow = Selectable<CronRunReceiptDatabase["cron_run_receipts"]>;

function isReceiptStatus(value: string): value is CronRunReceiptStatus {
  return (
    value === "running" ||
    value === "ok" ||
    value === "error" ||
    value === "skipped" ||
    value === "interrupted" ||
    value === "superseded"
  );
}

export function receiptFromRow(row: CronRunReceiptRow): CronRunReceipt {
  if (!isReceiptStatus(row.status)) {
    throw new Error(`invalid cron run receipt status ${row.status}`);
  }
  return {
    receiptId: row.receipt_id,
    storeKey: row.store_key,
    jobId: row.job_id,
    configRevision: row.config_revision,
    agentId: row.agent_id,
    ...(row.request_run_id ? { requestRunId: row.request_run_id } : {}),
    status: row.status,
    ownerPid: row.owner_pid,
    ownerStartTime: row.owner_start_time,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    ...(row.error_text ? { error: row.error_text } : {}),
  };
}

export function receiptHandle(receipt: CronRunReceipt): CronRunReceiptHandle {
  return {
    receiptId: receipt.receiptId,
    storeKey: receipt.storeKey,
    jobId: receipt.jobId,
    configRevision: receipt.configRevision,
    agentId: receipt.agentId,
    ownerPid: receipt.ownerPid,
    ownerStartTime: receipt.ownerStartTime,
    startedAtMs: receipt.startedAtMs,
  };
}

/** Observe existing receipts without the writable owner's first-use initialization. */
export function readActiveCronRunReceiptsInDatabase(
  database: DatabaseSync,
  storeKey: string,
  jobIds: readonly string[],
): CronRunReceiptRecoveryCandidate[] {
  const rows = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<CronRunReceiptDatabase>(database)
      .selectFrom("cron_run_receipts")
      .selectAll()
      .where("store_key", "=", storeKey)
      .where("status", "=", "running")
      .where("job_id", "in", sqliteStringSet(jobIds)),
  ).rows;
  const selected = new Set(jobIds);
  return rows
    .filter((row) => selected.has(row.job_id))
    .map((row) => receiptHandle(receiptFromRow(row)));
}
