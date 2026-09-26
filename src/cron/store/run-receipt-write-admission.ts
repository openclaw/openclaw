import type { DatabaseSync } from "node:sqlite";

/** Snapshot facts for one locked write; never retain them across transaction admission. */
export type CronRunReceiptWriteSchema = Readonly<{
  executionOwnerLifecycleBindings: boolean;
  cronRunReceipts: boolean;
}>;

/** Capture optional storage once at the owning write transaction's admission. */
export function prepareCronRunReceiptWriteSchema(db: DatabaseSync): CronRunReceiptWriteSchema {
  if (!db.isTransaction) {
    throw new Error("Cron receipt schema admission requires the owning write transaction");
  }
  // No handle cache: another connection can allocate the opt-in table, and a
  // failed first binding can roll its DDL back. Each admission uses its own
  // locked snapshot; receipt kernels and pruning consume only the carried fact.
  // sqlite-allow-raw -- Feature write admission captures optional table presence, never runtime kernels.
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('execution_owner_lifecycle_bindings', 'cron_run_receipts')",
    )
    .all();
  return {
    executionOwnerLifecycleBindings: rows.some(
      (row) => row.name === "execution_owner_lifecycle_bindings",
    ),
    cronRunReceipts: rows.some((row) => row.name === "cron_run_receipts"),
  };
}
