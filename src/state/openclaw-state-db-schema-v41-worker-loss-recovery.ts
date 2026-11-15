import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const stateWorkerLossRecoveryMigration = {
  version: 41,
  tables: ["session_repository_workspaces", "worker_session_placements"],
  columns: [
    "session_repository_workspaces.recovery_json",
    "worker_session_placements.confirmed_loss_recovery_json",
  ],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 41) {
      return false;
    }
    // Existing workspaces and placements retain their original authority; migration invents no loss receipt.
    const repository = ensureColumn(db, "session_repository_workspaces", "recovery_json TEXT");
    const placement = ensureColumn(
      db,
      "worker_session_placements",
      "confirmed_loss_recovery_json TEXT",
    );
    return repository || placement;
  },
  applied: "Repository replacement provenance and confirmed worker predecessor (v41)",
};

/** Exact predecessor DDL for native admission and PostgreSQL backup restoration. */
export function withLegacyWorkerLossRecovery(schema: string): string {
  return schema.replace(
    /\n {2}(?:(?:recovery_json|confirmed_loss_recovery_json) TEXT|"(?:recovery_json|confirmed_loss_recovery_json)" text COLLATE "C"),/gu,
    "",
  );
}
