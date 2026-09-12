import type { DatabaseSync } from "node:sqlite";
import { readSqliteUserVersion } from "./sqlite-user-version.js";

export type SqliteSchemaHeader = {
  userVersion: number;
  writerAppVersion?: string;
};

export function readSqliteWriterAppVersion(database: DatabaseSync): string | undefined {
  try {
    // Schema metadata inspection also accepts older or newer metadata contracts.
    const row = database
      .prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
      .get();
    return typeof row?.app_version === "string" && row.app_version.length > 0
      ? row.app_version
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read both metadata values from one fresh SQLite read transaction, including WAL. */
export function readSqliteSchemaHeader(database: DatabaseSync): SqliteSchemaHeader {
  database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN;");
  try {
    const userVersion = readSqliteUserVersion(database);
    const writerAppVersion = readSqliteWriterAppVersion(database);
    return { userVersion, ...(writerAppVersion ? { writerAppVersion } : {}) };
  } finally {
    database.exec("ROLLBACK;");
  }
}
