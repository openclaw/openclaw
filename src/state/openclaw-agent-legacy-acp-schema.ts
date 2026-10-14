import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { LEGACY_ACP_MIGRATION_COLUMN_DEFINITION } from "./openclaw-agent-db-additive-columns.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

const provenanceSchemas = new WeakSet<DatabaseSync>();

export function hasLegacyAcpMigrationProvenanceColumn(database: DatabaseSync): boolean {
  if (provenanceSchemas.has(database)) {
    return true;
  }
  const { columnName, tableName } = LEGACY_ACP_MIGRATION_COLUMN_DEFINITION;
  const exists = tableHasColumn(database, tableName, columnName);
  if (exists && !database.isTransaction) {
    provenanceSchemas.add(database);
  }
  return exists;
}

export function ensureLegacyAcpMigrationProvenanceColumn(database: DatabaseSync): void {
  if (provenanceSchemas.has(database)) {
    return;
  }
  const { columnName, dataType, tableName } = LEGACY_ACP_MIGRATION_COLUMN_DEFINITION;
  if (
    !hasLegacyAcpMigrationProvenanceColumn(database) &&
    !ensureColumn(database, tableName, `${columnName} ${dataType}`)
  ) {
    return;
  }
  const rememberSchema = () => provenanceSchemas.add(database);
  if (database.isTransaction) {
    // An outer rollback must not leave this connection claiming the column exists.
    deferSqlitePostCommitPublication(database, rememberSchema);
  } else {
    rememberSchema();
  }
}
