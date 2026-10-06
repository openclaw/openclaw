import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readAgentDeletionJournalInDatabase } from "../../state/agent-deletion-journal.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import { projectCronReceiptAuthorityJobFacts } from "./receipt-authority-facts.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import type {
  CronRunReceipt,
  CronRunReceiptCurrentFacts,
  CronRunReceiptCurrentReadCommand,
  CronRunReceiptHandle,
  CronRunReceiptOwnerObservation,
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

export function matchesCronRunReceiptOwner(
  current: CronRunReceiptHandle | undefined,
  expected: CronRunReceiptCurrentReadCommand["handle"],
): boolean {
  return (
    current !== undefined &&
    current.receiptId === expected.receiptId &&
    current.ownerPid === expected.ownerPid &&
    current.ownerStartTime === expected.ownerStartTime
  );
}

/** Current receipt, definition and deletion facts share one native read snapshot. */
export function readCronRunReceiptCurrentFactsInDatabase(
  database: DatabaseSync,
  command: CronRunReceiptCurrentReadCommand,
): CronRunReceiptCurrentFacts {
  return runSqliteDeferredTransactionSync(database, () => {
    const { handle } = command;
    const deletionBlocked =
      command.includeAvailability &&
      Boolean(readAgentDeletionJournalInDatabase({ db: database }, handle.agentId, "runtime"));
    let receipt: CronRunReceiptHandle | undefined;
    try {
      receipt = readActiveCronRunReceiptsInDatabase(database, handle.storeKey, [handle.jobId])[0];
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "no such table: cron_run_receipts") {
        throw error;
      }
    }
    const job =
      command.includeJob && matchesCronRunReceiptOwner(receipt, handle)
        ? loadedCronStoreFromRows(loadCronRows(database, handle.storeKey, new Set([handle.jobId])))
            .store.jobs[0]
        : undefined;
    return {
      receipt,
      job: job ? projectCronReceiptAuthorityJobFacts(job) : undefined,
      deletionBlocked,
    };
  });
}

/** Observe existing receipts without the writable owner's first-use initialization. */
export function readActiveCronRunReceiptsInDatabase(
  database: DatabaseSync,
  storeKey: string | undefined,
  jobIds: readonly string[],
): CronRunReceiptRecoveryCandidate[] {
  let query = getNodeSqliteKysely<CronRunReceiptDatabase>(database)
    .selectFrom("cron_run_receipts")
    .selectAll()
    .where("status", "=", "running")
    .where("job_id", "in", sqliteStringSet(jobIds));
  if (storeKey !== undefined) {
    query = query.where("store_key", "=", storeKey);
  }
  const rows = executeSqliteQuerySync(database, query).rows;
  const selected = new Set(jobIds);
  return rows
    .filter((row) => selected.has(row.job_id))
    .map((row) => receiptHandle(receiptFromRow(row)));
}

/** Drainage needs receipt ownership even after its scheduled job has been removed. */
export function readActiveCronRunReceiptOwnersInDatabase(
  database: DatabaseSync,
  agentId: string,
): CronRunReceiptOwnerObservation[] {
  try {
    return executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<CronRunReceiptDatabase>(database)
        .selectFrom("cron_run_receipts")
        .select(["receipt_id", "owner_pid", "owner_start_time", "started_at_ms"])
        .where("status", "=", "running")
        .where("agent_id", "=", agentId),
    ).rows.map((row) => ({
      receiptId: row.receipt_id,
      ownerPid: row.owner_pid,
      ownerStartTime: row.owner_start_time,
      startedAtMs: row.started_at_ms,
    }));
  } catch (error) {
    // This additive table is initialized by the first receipt claim, never by a read.
    if (error instanceof Error && error.message === "no such table: cron_run_receipts") {
      return [];
    }
    throw error;
  }
}
