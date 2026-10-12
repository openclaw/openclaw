import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { CronJob } from "../types.js";
import { loadCronRows } from "./row-codec.js";
import type { CronRunReceiptDatabase } from "./run-receipt-read.js";
import {
  assertCronRunReceiptCurrentInDatabase,
  assertCronRunReceiptOwnedInDatabase,
} from "./run-receipt-store.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

/** An exact live receipt owns the monotonic possible-delivery fact; this is not a success verdict. */
export function markCronDeliveryStartedInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  allowMissingJob: boolean;
  resolveAgentId: (job: CronJob) => string;
}): void {
  const removedByThisRun =
    params.allowMissingJob &&
    loadCronRows(params.database, params.handle.storeKey, new Set([params.handle.jobId])).length ===
      0;
  if (removedByThisRun) {
    assertCronRunReceiptOwnedInDatabase(params);
  } else {
    assertCronRunReceiptCurrentInDatabase(params);
  }
  executeSqliteQuerySync(
    params.database,
    getNodeSqliteKysely<CronRunReceiptDatabase>(params.database)
      .updateTable("cron_run_receipts")
      .set({ delivery_attempt_state: "started" })
      .where("receipt_id", "=", params.handle.receiptId)
      .where("delivery_attempt_state", "!=", "started"),
  );
}
