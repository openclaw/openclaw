import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";

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
  // The schema owner observes foreign commits and rolled-back DDL while
  // preserving this locked snapshot; kernels consume only the carried facts.
  return {
    executionOwnerLifecycleBindings: tableExists(db, "execution_owner_lifecycle_bindings"),
    cronRunReceipts: tableExists(db, "cron_run_receipts"),
  };
}
