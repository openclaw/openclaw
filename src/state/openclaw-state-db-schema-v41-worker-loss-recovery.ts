import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const stateWorkerLossRecoveryMigration = {
  version: 41,
  tables: ["worker_session_placements"],
  columns: ["worker_session_placements.confirmed_loss_recovery_json"],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 41) {
      return false;
    }
    // Reserve the field without inferring loss or changing any placement.
    return ensureColumn(db, "worker_session_placements", "confirmed_loss_recovery_json TEXT");
  },
  applied: "Confirmed worker-loss predecessor metadata (v41)",
};

/** Exact predecessor DDL for native admission and PostgreSQL backup restoration. */
export function withLegacyWorkerLossRecovery(schema: string): string {
  return schema.replace(
    /\n {2}(?:confirmed_loss_recovery_json TEXT|"confirmed_loss_recovery_json" text COLLATE "C"),/gu,
    "",
  );
}
