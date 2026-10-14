import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { CronRunReceiptDatabase } from "./run-receipt-read.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

/** Record possible delivery for restart diagnostics without deciding effect permissions. */
export function markCronDeliveryStartedInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
}): void {
  executeSqliteQuerySync(
    params.database,
    getNodeSqliteKysely<CronRunReceiptDatabase>(params.database)
      .updateTable("cron_run_receipts")
      .set({ delivery_attempt_state: "started" })
      .where("receipt_id", "=", params.handle.receiptId)
      .where("status", "=", "running")
      .where("delivery_attempt_state", "!=", "started"),
  );
}
