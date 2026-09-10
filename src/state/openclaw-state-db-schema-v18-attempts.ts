import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const TABLE = "task_flow_workspace_allocations";
const TEMP = "task_flow_workspace_allocations_migration_v18";
const normalize = (sql: string) =>
  sql
    .replace(/IF NOT EXISTS\s+/gi, "")
    .replace(/"task_flow_workspace_allocations"/g, TABLE)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");

/** Called inside the schema migration transaction with FK checking disabled.
 * Resource-only attempts need an episode-owned allocation, not a fabricated
 * workflow contract. Preserve existing allocation IDs and every evidence row. */
export function migrateSupervisedAttemptAllocationsV18(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (previousVersion >= 18 || !tableExists(db, TABLE)) {
    return false;
  }
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${TABLE} (`);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(") STRICT;", start);
  if (start < 0 || end < start) {
    throw new Error("Canonical attempt allocation schema missing");
  }
  const canonical = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + ") STRICT;".length);
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(TABLE);
  if (typeof row?.sql !== "string") {
    throw new Error("Attempt allocation schema is unavailable; preserve for reconciliation");
  }
  if (normalize(row.sql) === normalize(canonical)) {
    return false;
  }
  const legacy = canonical.replace(
    "REFERENCES task_flow_episodes(flow_id, episode)",
    "REFERENCES task_flow_contracts(flow_id, episode)",
  );
  if (normalize(row.sql) !== normalize(legacy) || tableExists(db, TEMP)) {
    throw new Error("Unrecognized attempt allocation schema; preserve for explicit reconciliation");
  }
  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL AND type != 'table'",
    )
    .all(TABLE);
  const indexes: string[] = [];
  const allowed = new Set([
    "idx_task_flow_workspace_allocations_owner",
    "idx_task_flow_workspace_allocations_retention",
  ]);
  for (const object of objects) {
    if (typeof object.name !== "string" || typeof object.sql !== "string") {
      throw new Error("Attempt allocation has unsupported attached objects");
    }
    const indexStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      `CREATE INDEX IF NOT EXISTS ${object.name}\n`,
    );
    const indexEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(";", indexStart);
    if (
      object.type !== "index" ||
      !allowed.has(object.name) ||
      indexStart < 0 ||
      normalize(object.sql) !== normalize(OPENCLAW_STATE_SCHEMA_SQL.slice(indexStart, indexEnd + 1))
    ) {
      throw new Error("Attempt allocation has unsupported attached objects");
    }
    indexes.push(object.sql);
  }
  db.exec(canonical.replace(`CREATE TABLE IF NOT EXISTS ${TABLE}`, `CREATE TABLE ${TEMP}`));
  db.exec(
    `INSERT INTO ${TEMP} SELECT * FROM ${TABLE}; DROP TABLE ${TABLE}; ALTER TABLE ${TEMP} RENAME TO ${TABLE};`,
  );
  for (const sql of indexes) {
    db.exec(sql);
  }
  return true;
}
