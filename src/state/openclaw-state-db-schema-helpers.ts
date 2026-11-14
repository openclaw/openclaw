import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { executeWithCachedStatement } from "../infra/kysely-sync-cache-state.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { sqlitePrimaryResultCode } from "../infra/sqlite-error-diagnostics.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  findSqlCharacter,
  findSqlClosingParenthesis,
  hasUnquotedSqlKeyword,
  normalizeSqlIdentifier,
  readSqlToken,
  readTableConstraintKeyword,
  splitSqlList,
} from "../infra/sqlite-schema-sql.js";

const tableColumns = new WeakMap<SqliteSchemaFacts, Map<string, Set<string>>>();

function readCanonicalTableDefinition(sql: string, tableName: string) {
  if (!/^CREATE TABLE\b/iu.test(sql) || hasUnquotedSqlKeyword(sql, /\bAS\b/giu)) {
    return undefined;
  }
  const definition = parseSqliteTableDefinition(sql, tableName);
  // table_info omits generated columns and preserves identifier spelling.
  // Noncanonical identifiers and unsupported constraint names keep native inspection.
  return [...definition.columns.values()].every((column) => {
    const token = readSqlToken(column, 0);
    return token?.keyword !== "CONSTRAINT" && /^[a-z_][a-z0-9_]*$/u.test(token?.raw ?? "");
  })
    ? definition
    : undefined;
}

export function tableHasColumn(
  db: EngineConnection,
  tableName: string,
  columnName: string,
): boolean {
  return readTableColumns(db, tableName).has(columnName);
}

export function readTableColumns(db: EngineConnection, tableName: string): Set<string> {
  if (isPostgresSqlConnection(db)) {
    return new Set(
      getPostgresPhysicalFacts(db)?.catalog.flatMap((fact) =>
        fact.table === tableName &&
        fact.kind === "column" &&
        fact.value &&
        typeof fact.value === "object" &&
        "name" in fact.value &&
        typeof fact.value.name === "string"
          ? [fact.value.name]
          : [],
      ) ?? [],
    );
  }
  const schema = getAdmittedSqliteSchemaFacts(db);
  const sql = schema?.tableSql.get(tableName);
  if (
    schema &&
    !sql &&
    ![...schema.tables, ...schema.views].some(
      (name) => name.toLowerCase() === tableName.toLowerCase(),
    )
  ) {
    return new Set();
  }
  if (schema && sql) {
    let tables = tableColumns.get(schema);
    const retained = tables?.get(tableName);
    if (retained) {
      return retained;
    }
    const definition = readCanonicalTableDefinition(sql, tableName);
    if (definition) {
      const columns = new Set(definition.columns.keys());
      if (!tables) {
        tables = new Map();
        tableColumns.set(schema, tables);
      }
      tables.set(tableName, columns);
      return columns;
    }
  }
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

/** Inspect only failed queries; native unavailability must not become a schema refusal. */
export function classifySqliteTableReadError(
  db: EngineConnection,
  tableName: string,
  columnNames: readonly string[],
  error: unknown,
): unknown {
  if (isPostgresSqlConnection(db)) {
    return error;
  }
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

export function tablePrimaryKeyColumns(db: EngineConnection, tableName: string): string[] {
  if (isPostgresSqlConnection(db)) {
    const value = getPostgresPhysicalFacts(db)?.catalog.find(
      (fact) => fact.table === tableName && fact.kind === "primaryKey",
    )?.value;
    return Array.isArray(value)
      ? value.filter((column): column is string => typeof column === "string")
      : [];
  }
  const sql = getAdmittedSqliteSchemaFacts(db)?.tableSql.get(tableName);
  const definition = sql && readCanonicalTableDefinition(sql, tableName);
  if (definition) {
    const key = definition.constraints.find((constraint) => {
      const first = readSqlToken(constraint, 0);
      return first && readTableConstraintKeyword(constraint, first) === "PRIMARY";
    });
    if (!key) {
      return [...definition.columns].flatMap(([name, column]) =>
        hasUnquotedSqlKeyword(column, /\bPRIMARY\s+KEY\b/giu) ? [name] : [],
      );
    }
    const open = findSqlCharacter(key, "(");
    const columns = splitSqlList(key.slice(open + 1, findSqlClosingParenthesis(key, open))).map(
      (term) => normalizeSqlIdentifier(readSqlToken(term, 0)?.raw ?? ""),
    );
    if (columns.every((column) => definition.columns.has(column))) {
      return [...new Set(columns)];
    }
  }
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows
    .filter((row) => Number(row.pk ?? 0) > 0 && typeof row.name === "string")
    .toSorted((left, right) => Number(left.pk ?? 0) - Number(right.pk ?? 0))
    .map((row) => row.name as string);
}

export function tableExists(db: EngineConnection, tableName: string): boolean {
  if (isPostgresSqlConnection(db)) {
    return (
      getPostgresPhysicalFacts(db)?.catalog.some(
        (fact) => fact.table === tableName && fact.kind === "table",
      ) ?? false
    );
  }
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

export function ensureColumn(db: EngineConnection, tableName: string, columnSql: string): boolean {
  const columnName = columnSql.trim().split(/\s+/, 1)[0];
  if (!columnName || !tableExists(db, tableName) || tableHasColumn(db, tableName, columnName)) {
    return false;
  }
  // State migrations are additive here; destructive or shape-changing repairs belong in doctor.
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
  return true;
}

/** Missing runtime tables are empty only before state grows beyond checkpoint bootstrap. */
export function hasOpenClawStateTablesBeyondStartupCheckpoint(db: EngineConnection): boolean {
  if (isPostgresSqlConnection(db)) {
    return true;
  }
  return (
    /* sqlite-allow-raw -- Read-only startup-checkpoint schema discriminator. */ db
      .prepare(
        "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name NOT IN ('schema_meta', 'state_leases') LIMIT 1",
      )
      .get() !== undefined
  );
}
