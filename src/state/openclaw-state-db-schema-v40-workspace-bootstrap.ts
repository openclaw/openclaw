import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const stateWorkspaceBootstrapDeferralMigration = {
  version: 40,
  tables: ["workspace_setup_state"],
  columns: ["workspace_setup_state.bootstrap_deferred"],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 40) {
      return false;
    }
    // A v39 store may already have the column from its former first-use writer.
    return ensureColumn(db, "workspace_setup_state", "bootstrap_deferred INTEGER");
  },
  applied: "Recorded deferred Template bootstrap seeding on workspace setup (v40)",
};

/** Exact predecessor DDL for native admission and PostgreSQL backup restoration. */
export function withLegacyWorkspaceBootstrapDeferral(schema: string): string {
  return schema.replace(
    /\n {2}bootstrap_deferred INTEGER,|\n {2}"bootstrap_deferred" bigint,/gu,
    "",
  );
}
