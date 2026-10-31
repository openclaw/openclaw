import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

/** Absence of old delivery evidence cannot prove that a completion was never sent. */
export function migrateCronDeliveryAttemptState(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  return previousVersion < 20 && tableExists(db, "cron_run_receipts")
    ? ensureColumn(
        db,
        "cron_run_receipts",
        "delivery_attempt_state TEXT NOT NULL DEFAULT 'unknown' CHECK (delivery_attempt_state IN ('unknown', 'not-started', 'started'))",
      )
    : false;
}
