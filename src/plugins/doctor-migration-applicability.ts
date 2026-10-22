import type { OpenClawConfig } from "../config/types.openclaw.js";
import { selectDatabaseEngine } from "../infra/database-engine/registry.js";
import type { PluginDoctorStateMigration } from "./doctor-contract-module.js";

/** Decide before any legacy reader opens a PostgreSQL anchor as SQLite application data. */
export function sqliteOnlyMigrationNotice(
  migration: PluginDoctorStateMigration,
  config: OpenClawConfig,
): string | undefined {
  const declaration = migration.sqliteOnly;
  if (
    !declaration ||
    selectDatabaseEngine({ id: declaration.family, postgres: true }, config) !== "postgres"
  ) {
    return undefined;
  }
  return `${migration.label}: legacy SQLite migration not applicable on PostgreSQL; legacy data is migrated before port.${declaration.postgresNote ? ` ${declaration.postgresNote}` : ""}`;
}
