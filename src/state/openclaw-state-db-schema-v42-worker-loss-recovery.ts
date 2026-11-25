import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const stateWorkerLossRecoveryMigration = {
  version: 42,
  tables: ["worker_session_placements"],
  columns: ["worker_session_placements.confirmed_loss_recovery_json"],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 42) {
      return false;
    }
    // Reserve the field without inferring loss or changing any placement.
    return ensureColumn(db, "worker_session_placements", "confirmed_loss_recovery_json TEXT");
  },
  applied: "Confirmed worker-loss predecessor metadata (v42)",
};

/** Exact predecessor DDL for native admission and PostgreSQL backup restoration. */
export function withLegacyWorkerLossRecovery(schema: string): string {
  return schema
    .replace("  confirmed_loss_recovery_json TEXT,\n", "")
    .replace('  "confirmed_loss_recovery_json" text COLLATE "C",\n', "");
}
