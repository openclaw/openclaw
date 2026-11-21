import type { EngineConnection } from "../../infra/sql-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";

/** Optional tables supplied by the shared physical database schema owner. */
export type CronRunReceiptWriteSchema = Readonly<{
  executionOwnerLifecycleBindings: boolean;
  cronRunReceipts: boolean;
}>;

/** Reuse admitted schema facts for the owning write transaction. */
export function prepareCronRunReceiptWriteSchema(db: EngineConnection): CronRunReceiptWriteSchema {
  if (!db.isTransaction) {
    throw new Error("Cron receipt schema admission requires the owning write transaction");
  }
  // The schema owner publishes committed DDL and discards rolled-back changes.
  return {
    executionOwnerLifecycleBindings: tableExists(db, "execution_owner_lifecycle_bindings"),
    cronRunReceipts: tableExists(db, "cron_run_receipts"),
  };
}
