import type { SqliteIntegrityCheckOptions } from "../infra/sqlite-integrity.js";
import type { IncompatibleOpenClawDatabase } from "./openclaw-database-preflight.types.js";
import { SCHEMA_MIGRATION_BACKUP_TABLES } from "./schema-migration-backup-tables.js";

/** Missing steps and same-version repairs retain the full-file recovery contract. */
export function resolveSchemaMigrationBackupTables(
  migration: Pick<IncompatibleOpenClawDatabase, "kind" | "foundVersion" | "supportedVersion">,
): readonly string[] | undefined {
  if (migration.foundVersion <= 0 || migration.foundVersion >= migration.supportedVersion) {
    return undefined;
  }
  const tables = new Set(["schema_meta"]);
  for (let version = migration.foundVersion + 1; version <= migration.supportedVersion; version++) {
    const scope = SCHEMA_MIGRATION_BACKUP_TABLES[migration.kind][version];
    if (!scope) {
      return undefined;
    }
    for (const table of scope) {
      tables.add(table);
    }
  }
  // Older update drivers can defer publication while content migrations advance.
  if (migration.kind === "state") {
    tables.add("config_machine_state");
  }
  return [...tables].toSorted();
}

/** Undeclared historical migrations keep full verification until their write scope is known. */
export function resolveSchemaMigrationIntegrityCheck(
  migration: Pick<IncompatibleOpenClawDatabase, "kind" | "foundVersion" | "supportedVersion">,
  check: "quick" | "full" = "quick",
): SqliteIntegrityCheckOptions {
  if (check === "full" || migration.foundVersion >= migration.supportedVersion) {
    return { check };
  }
  const tables = resolveSchemaMigrationBackupTables(migration);
  return tables ? { check, tables } : { check: "full" };
}
