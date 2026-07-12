import type { DatabaseSync } from "node:sqlite";

export type SqliteIntegrityChecks = {
  integrityCheck: "ok";
  quickCheck: "ok";
};

type SqliteCheckPragma = "integrity_check" | "quick_check";
type SqliteForeignKeyViolation = {
  fkid: bigint;
  parent: string;
  rowid: bigint | null;
  table: string;
};

const MAX_REPORTED_FOREIGN_KEY_VIOLATIONS = 5;

/** Require structural, table/index, and referential consistency before trusting a database. */
export function assertSqliteIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
): SqliteIntegrityChecks {
  const quickCheck = runSqliteCheck(database, databaseLabel, "quick_check");
  const integrityCheck = runSqliteCheck(database, databaseLabel, "integrity_check");
  runSqliteForeignKeyCheck(database, databaseLabel);
  return { integrityCheck, quickCheck };
}

/** Require table and associated index consistency before trusting indexed reads. */
export function assertSqliteTableIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
  tableName: string,
): void {
  runSqliteCheck(database, `${databaseLabel} table ${tableName}`, "integrity_check", tableName);
}

function runSqliteCheck(
  database: DatabaseSync,
  databaseLabel: string,
  pragma: SqliteCheckPragma,
  tableName?: string,
): "ok" {
  const argument = tableName ? `('${tableName.replaceAll("'", "''")}')` : "";
  const rows = database.prepare(`PRAGMA ${pragma}${argument};`).all() as Array<
    Record<string, unknown>
  >;
  const results = rows.map((row) => row[pragma] ?? Object.values(row)[0]);
  if (results.length === 1 && results[0] === "ok") {
    return "ok";
  }
  const details = results.map((result) => String(result)).join("; ") || "no result";
  throw new Error(`SQLite ${pragma} failed for ${databaseLabel}: ${details}`);
}

function runSqliteForeignKeyCheck(database: DatabaseSync, databaseLabel: string): void {
  let violations: SqliteForeignKeyViolation[];
  try {
    const statement = database.prepare(`
      SELECT "table", rowid, parent, fkid
      FROM pragma_foreign_key_check
      ORDER BY
        "table" COLLATE BINARY,
        rowid IS NOT NULL,
        rowid,
        parent COLLATE BINARY,
        fkid
      LIMIT ?
    `);
    statement.setReadBigInts(true);
    violations = statement.all(
      MAX_REPORTED_FOREIGN_KEY_VIOLATIONS + 1,
    ) as SqliteForeignKeyViolation[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite foreign_key_check failed for ${databaseLabel}: ${message}`, {
      cause: error,
    });
  }
  if (violations.length === 0) {
    return;
  }

  const details = violations
    .slice(0, MAX_REPORTED_FOREIGN_KEY_VIOLATIONS)
    .map(formatSqliteForeignKeyViolation);
  if (violations.length > MAX_REPORTED_FOREIGN_KEY_VIOLATIONS) {
    details.push("additional violations omitted");
  }
  throw new Error(`SQLite foreign_key_check failed for ${databaseLabel}: ${details.join("; ")}`);
}

function formatSqliteForeignKeyViolation(violation: SqliteForeignKeyViolation): string {
  const row = violation.rowid === null ? "row without rowid" : `row ${violation.rowid.toString()}`;
  return `${violation.table} ${row} references ${violation.parent} (foreign key ${violation.fkid.toString()})`;
}
