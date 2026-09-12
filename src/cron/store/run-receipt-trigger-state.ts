import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import type { CronRunReceiptHandle } from "./run-receipt-store.js";

type CronRunTriggerStateDatabase = Pick<
  OpenClawStateDatabase,
  "cron_run_receipts" | "cron_run_trigger_state_retirements"
>;
type CronRunReceiptStateWriter = Pick<
  CronRunReceiptHandle,
  "receiptId" | "storeKey" | "jobId" | "startedAtMs"
>;
const RETIREMENTS_TABLE = "cron_run_trigger_state_retirements";

function query(database: DatabaseSync) {
  return getNodeSqliteKysely<CronRunTriggerStateDatabase>(database);
}

function stateWriterQuery(database: DatabaseSync, handle: CronRunReceiptStateWriter) {
  return query(database)
    .selectFrom("cron_run_receipts")
    .where("cron_run_receipts.receipt_id", "=", handle.receiptId)
    .where("cron_run_receipts.store_key", "=", handle.storeKey)
    .where("cron_run_receipts.job_id", "=", handle.jobId)
    .where("cron_run_receipts.started_at_ms", "=", handle.startedAtMs);
}

function ensureRetirementsTable(database: DatabaseSync): void {
  if (tableExists(database, RETIREMENTS_TABLE)) {
    return;
  }
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    `CREATE TABLE IF NOT EXISTS ${RETIREMENTS_TABLE} (`,
  );
  const endMarker = "\n) STRICT;";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start);
  if (start < 0 || end < start) {
    throw new Error("OpenClaw cron run trigger-state retirement schema is missing.");
  }
  // sqlite-allow-raw -- Canonical first-use DDL rolls back with the owning edit.
  database.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + endMarker.length));
}

/** Retires the exact pending state writer in the acknowledged edit's transaction. */
export function retireCronRunTriggerStateInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptStateWriter;
}): void {
  const { database, handle } = params;
  const receipt = executeSqliteQueryTakeFirstSync(
    database,
    stateWriterQuery(database, handle).select(["receipt_id", "started_at_ms"]),
  );
  if (!receipt) {
    return;
  }
  const job = loadedCronStoreFromRows(
    loadCronRows(database, handle.storeKey, new Set([handle.jobId])),
  ).store.jobs[0];
  // Queued runs capture current state at activation. Terminal receipts can
  // still own unreconciled facts, so the durable running marker gates retirement.
  if (job?.state.runningAtMs !== receipt.started_at_ms) {
    return;
  }
  ensureRetirementsTable(database);
  executeSqliteQuerySync(
    database,
    query(database)
      .insertInto(RETIREMENTS_TABLE)
      .values({ receipt_id: receipt.receipt_id })
      .onConflict((conflict) => conflict.column("receipt_id").doNothing()),
  );
}

/** Reads retirement after write admission without changing execution authority. */
export function isCronRunTriggerStateRetiredInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptStateWriter;
}): boolean {
  const { database, handle } = params;
  if (!tableExists(database, RETIREMENTS_TABLE)) {
    return false;
  }
  return (
    executeSqliteQueryTakeFirstSync(
      database,
      stateWriterQuery(database, handle)
        .innerJoin(
          RETIREMENTS_TABLE,
          `${RETIREMENTS_TABLE}.receipt_id`,
          "cron_run_receipts.receipt_id",
        )
        .select("cron_run_receipts.receipt_id"),
    ) !== undefined
  );
}
