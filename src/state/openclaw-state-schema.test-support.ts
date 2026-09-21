import { FIRST_USE_STATE_TABLES } from "./openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { createSqliteSchemaShapeFromSql } from "./sqlite-schema-shape.test-support.js";

export function createInitialStateSchemaShape() {
  const shape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-state-schema.sql", import.meta.url),
  );
  for (const tableName of FIRST_USE_STATE_TABLES) {
    delete shape[tableName];
  }
  return shape;
}

export function createOlderV6StateSchemaWithoutWorkerSshFallbackPorts(): string {
  const startMarker = "CREATE TABLE IF NOT EXISTS worker_environment_ssh_fallback_ports (";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(startMarker);
  const endMarker = "\n) STRICT;";
  const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    throw new Error("worker SSH fallback port schema block is missing");
  }
  return `${OPENCLAW_STATE_SCHEMA_SQL.slice(0, start)}${OPENCLAW_STATE_SCHEMA_SQL.slice(
    end + endMarker.length,
  )}`;
}
