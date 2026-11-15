import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export const WORKSPACE_CAS_TABLES = [
  "local_workspace_tree_packs",
  "local_workspace_source_path_sets",
] as const;
export const WORKSPACE_CAS_COLUMNS = [
  "tree_root_digest",
  "source_paths_digest",
  "canonical_fingerprints",
  "projection_fingerprints",
] as const;

/** DDL only: reconciliation converts retained baselines one projection at a time. */
function migrateLocalWorkspaceCas(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 35 || !tableExists(db, "local_workspace_projections")) {
    return false;
  }
  // SQLite validates this STRICT table per ALTER; the one-time 5–7 s cost on a 1 GB table is accepted.
  for (const column of WORKSPACE_CAS_COLUMNS) {
    ensureColumn(db, "local_workspace_projections", `${column} BLOB`);
  }
  for (const table of WORKSPACE_CAS_TABLES) {
    // sqlite-allow-raw -- Canonical DDL in the versioned shared-state schema transaction.
    db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table));
  }
  return true;
}

export const stateLocalWorkspaceCasMigration = {
  version: 35,
  tables: ["local_workspace_projections", ...WORKSPACE_CAS_TABLES],
  columns: WORKSPACE_CAS_COLUMNS.map((column) => `local_workspace_projections.${column}`),
  migrate: migrateLocalWorkspaceCas,
  applied: "Prepared shared content-addressed workspace trees and compact scan fingerprints (v35)",
};

/** Exact predecessor declarations for admission, migration backups and ports. */
export function withLegacyLocalWorkspaceCas(schema: string): string {
  return schema
    .replace(
      /\n {2}(?:tree_root_digest|source_paths_digest|canonical_fingerprints|projection_fingerprints) BLOB,/gu,
      "",
    )
    .replace(
      /\n {2}"(?:tree_root_digest|source_paths_digest|canonical_fingerprints|projection_fingerprints)" bytea,/gu,
      "",
    )
    .replace(
      /CREATE TABLE(?: IF NOT EXISTS)? "?local_workspace_(?:tree_packs|source_path_sets)"? \([\s\S]*?\n\)(?: STRICT(?:, WITHOUT ROWID)?)?;\n?/gu,
      "",
    );
}
