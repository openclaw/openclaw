import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema, quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

/** Existing accepted manifests retain their bytes and authority; no pending work is inferred. */
export function migrateWorkerRepositoryReadiness(db: DatabaseSync, previousVersion: number) {
  if (previousVersion >= 21 || !tableExists(db, "worker_session_placements")) {
    return false;
  }
  const table = "worker_session_placements";
  const temporary = "worker_session_placements_migration_v21";
  if (tableExists(db, temporary)) {
    throw new Error("Repository readiness migration already exists");
  }
  const retained = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
    )
    .all(table);
  db.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table).replace(
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      `CREATE TABLE ${temporary} (`,
    ),
  );
  const columns = db
    .prepare(`PRAGMA table_xinfo(${table})`)
    .all()
    .flatMap((row) =>
      row.hidden === 0 && typeof row.name === "string" ? [quoteSqliteIdentifier(row.name)] : [],
    );
  db.exec(
    `INSERT INTO ${temporary} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${temporary} RENAME TO ${table};`,
  );
  for (const row of retained) {
    if (typeof row.sql === "string") {
      db.exec(row.sql);
    }
  }
  return true;
}
