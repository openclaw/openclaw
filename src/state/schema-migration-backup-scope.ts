import type { SqliteIntegrityCheckOptions } from "../infra/sqlite-integrity.js";
import { SCHEMA_MIGRATION_BACKUP_TABLES } from "./schema-migration-backup-tables.js";
import { resolveSchemaMigrationIntegrityTables } from "./schema-migration-integrity-tables.js";

type SchemaMigration = {
  kind: "agent" | "state";
  foundVersion: number;
  supportedVersion: number;
};

/** Missing steps and same-version repairs retain the full-file recovery contract. */
export function resolveSchemaMigrationBackupTables(
  migration: SchemaMigration,
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

/** Backup format does not select integrity coverage, including same-version repair. */
export function resolveSchemaMigrationIntegrityCheck(
  migration: SchemaMigration,
  check: "quick" | "full" = "quick",
): SqliteIntegrityCheckOptions {
  if (check === "full") {
    return { check: "full" };
  }
  return {
    check,
    tables: resolveSchemaMigrationIntegrityTables(migration),
    ...(migration.kind === "agent" &&
    migration.foundVersion === 38 &&
    migration.supportedVersion === 39
      ? { schemaOnly: true as const }
      : {}),
  };
}
