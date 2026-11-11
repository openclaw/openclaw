// Test helper for reading SQLite pragma state.
import type { EngineConnection } from "./sql-connection.js";

// SQLite pragma test helpers normalize node:sqlite bigint/number outputs.
type SqliteNumberPragma =
  | "auto_vacuum"
  | "busy_timeout"
  | "foreign_keys"
  | "journal_size_limit"
  | "schema_version"
  | "synchronous"
  | "user_version"
  | "wal_autocheckpoint";

/** Read a numeric SQLite pragma from a database connection. */
export function readSqliteNumberPragma(db: EngineConnection, pragma: SqliteNumberPragma): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma] ?? row?.timeout;
  return typeof value === "bigint" ? Number(value) : Number(value);
}
