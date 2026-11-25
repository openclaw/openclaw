import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { CronRunReceiptDatabase } from "./run-receipt-read.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

export function hasCronRunDeliveryStartedInDatabase(
  database: EngineConnection,
  handle: CronRunReceiptHandle,
): boolean {
  return (
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<CronRunReceiptDatabase>(database)
        .selectFrom("cron_run_receipts")
        .select("delivery_attempt_state")
        .where("receipt_id", "=", handle.receiptId),
    ).rows[0]?.delivery_attempt_state !== "not-started"
  );
}

/** Record possible delivery for restart diagnostics without deciding effect permissions. */
export function markCronDeliveryStartedInDatabase(params: {
  database: EngineConnection;
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
