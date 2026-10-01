// Provides shared SQLite schema probes and additive column migration helpers.
import type { DatabaseSync } from "node:sqlite";
import { executeWithCachedStatement } from "../infra/kysely-sync-cache-state.js";
import { sqlitePrimaryResultCode } from "../infra/sqlite-error-diagnostics.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";

export function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  return tableHasColumns(db, tableName, [columnName]);
}

export function tableHasColumns(
  db: DatabaseSync,
  tableName: string,
  columnNames: readonly string[],
): boolean {
  const existing = readTableColumns(db, tableName);
  return columnNames.every((columnName) => existing.has(columnName));
}

function readTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

/** Inspect only failed queries; native unavailability must not become a schema refusal. */
export function classifySqliteTableReadError(
  db: DatabaseSync,
  tableName: string,
  columnNames: readonly string[],
  error: unknown,
): unknown {
  if (sqlitePrimaryResultCode(error) !== 1) {
    return error;
  }
  try {
    const existing = readTableColumns(db, tableName);
    // An authorizer can suppress PRAGMA results; empty inspection proves no column absence.
    if (existing.size > 0 && columnNames.some((column) => !existing.has(column))) {
      return new SqliteSchemaMismatchError(
        `SQLite table ${tableName} is missing required columns; run openclaw doctor --fix to repair it.`,
        { cause: error },
      );
    }
  } catch {
    // Failed diagnosis cannot replace the original native read failure.
  }
  return error;
}

export function tablePrimaryKeyColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows
    .filter((row) => Number(row.pk ?? 0) > 0 && typeof row.name === "string")
    .toSorted((left, right) => Number(left.pk ?? 0) - Number(right.pk ?? 0))
    .map((row) => row.name as string);
}

export function tableExists(db: DatabaseSync, tableName: string): boolean {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    return schema.tables.has(tableName);
  }
  const row = executeWithCachedStatement(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
    (statement) => statement.get(tableName),
  );
  return row?.ok === 1;
}

export function ensureColumn(db: DatabaseSync, tableName: string, columnSql: string): boolean {
  const columnName = columnSql.trim().split(/\s+/, 1)[0];
  if (!columnName || !tableExists(db, tableName) || tableHasColumn(db, tableName, columnName)) {
    return false;
  }
  // State migrations are additive here; destructive or shape-changing repairs belong in doctor.
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
  return true;
}

/** Missing runtime tables are empty only before state grows beyond checkpoint bootstrap. */
export function hasOpenClawStateTablesBeyondStartupCheckpoint(db: DatabaseSync): boolean {
  return (
    /* sqlite-allow-raw -- Read-only startup-checkpoint schema discriminator. */ db
      .prepare(
        "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name NOT IN ('schema_meta', 'state_leases') LIMIT 1",
      )
      .get() !== undefined
  );
}
