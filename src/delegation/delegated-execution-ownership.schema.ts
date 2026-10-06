/**
 * Feature-local additive schema ownership for the delegated execution registry.
 *
 * Mirrors the canonical OpenClaw convention used by
 * \`execution-owner-lifecycle-binding-store.ts\`: the canonical SQL in
 * \`openclaw-state-schema.sql\` owns the shape, and this module installs exactly
 * that slice at first admitted use with \`CREATE TABLE IF NOT EXISTS\`.
 */
import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

export const DELEGATED_EXECUTION_OWNERSHIP_TABLE = "delegated_execution_ownership" as const;
export const DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE =
  "delegated_execution_ownership_events" as const;

/** Short aliases shared with the state-layer v19 migration. */
export const DATA_TABLE = DELEGATED_EXECUTION_OWNERSHIP_TABLE;
export const EVENT_TABLE = DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE;

const OWNERSHIP_INDEXES = ["idx_delegated_execution_ownership_live"] as const;
const EVENT_INDEXES = ["idx_delegated_execution_ownership_events_ref"] as const;

function indexBlockSql(indexName: string): string {
  const plain = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE INDEX IF NOT EXISTS " + indexName);
  const unique = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE UNIQUE INDEX IF NOT EXISTS " + indexName,
  );
  const start = plain >= 0 ? plain : unique;
  const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(";", start) : -1;
  if (start < 0 || end < 0) {
    throw new Error("canonical delegated execution ownership index is missing: " + indexName);
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + 1);
}

function tableBlockSql(tableName: string): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS " + tableName + " (");
  const endMarker = ") STRICT;";
  const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    throw new Error("canonical delegated execution ownership table is missing: " + tableName);
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + endMarker.length);
}

/** Canonical DDL for the registry, extracted verbatim so shape cannot drift. */
export function delegatedExecutionOwnershipSchemaSql(): string {
  return [
    tableBlockSql(DELEGATED_EXECUTION_OWNERSHIP_TABLE),
    ...[...OWNERSHIP_INDEXES].map(indexBlockSql),
    tableBlockSql(DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE),
    ...[...EVENT_INDEXES].map(indexBlockSql),
  ].join("\n");
}

/**
 * Installs the registry tables idempotently. Returns true when the schema was
 * already present so callers can distinguish "opened an owned registry" from
 * "created the storage this call".
 */
export function ensureDelegatedExecutionOwnershipSchema(db: DatabaseSync): boolean {
  const owned =
    tableExists(db, DELEGATED_EXECUTION_OWNERSHIP_TABLE) &&
    tableExists(db, DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE);
  if (owned) {
    return true;
  }
  // sqlite-allow-raw -- canonical feature-local additive DDL only; rows use Kysely.
  db.exec(delegatedExecutionOwnershipSchemaSql());
  return false;
}

/** True when both registry tables are present in this database. */
export function hasDelegatedExecutionOwnershipSchema(db: DatabaseSync): boolean {
  return (
    tableExists(db, DELEGATED_EXECUTION_OWNERSHIP_TABLE) &&
    tableExists(db, DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE)
  );
}
