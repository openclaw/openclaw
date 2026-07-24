import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_AGENT_SCHEMA_WITHOUT_SESSION_SHARING_SQL } from "./openclaw-agent-session-sharing-schema.js";

const LOGICAL_TURN_SCHEMA_START = "CREATE TABLE IF NOT EXISTS logical_turns (";
const LOGICAL_TURN_SCHEMA_END = "CREATE TABLE IF NOT EXISTS cache_entries (";

function splitLogicalTurnSchema(sql: string): { logicalTurn: string; withoutLogicalTurn: string } {
  const start = sql.indexOf(LOGICAL_TURN_SCHEMA_START);
  const end = sql.indexOf(LOGICAL_TURN_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw agent logical-turn schema markers are missing.");
  }
  return {
    logicalTurn: sql.slice(start, end),
    withoutLogicalTurn: `${sql.slice(0, start)}${sql.slice(end)}`,
  };
}

const logicalTurnSchema = splitLogicalTurnSchema(OPENCLAW_AGENT_SCHEMA_WITHOUT_SESSION_SHARING_SQL);

export const AGENT_SCHEMA_WITHOUT_LAZY_SURFACES_SQL = logicalTurnSchema.withoutLogicalTurn;

function ensureLogicalTurnEffectColumns(db: DatabaseSync): void {
  const logicalTurnColumns = new Set(
    (db.prepare("PRAGMA table_xinfo('logical_turns')").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (logicalTurnColumns.size > 0 && !logicalTurnColumns.has("delivery_ref")) {
    db.exec(
      "ALTER TABLE logical_turns ADD COLUMN delivery_ref TEXT", // sqlite-allow-raw -- Fixed additive column for the lazy v14 surface.
    );
  }
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get("logical_turn_effects");
  if (!table) {
    return;
  }
  const columns = new Set(
    (db.prepare("PRAGMA table_xinfo('logical_turn_effects')").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const additions = [
    ["assistant_checkpoint_id", "TEXT"],
    ["tool_call_id", "TEXT"],
    ["tool_name", "TEXT"],
    ["replay_class", "TEXT"],
    ["downstream_idempotency_key", "TEXT"],
    ["effect_state", "TEXT NOT NULL DEFAULT 'planned'"],
    ["dispatched_at", "INTEGER"],
    ["reconciled_at", "INTEGER"],
    ["reconciliation_generation", "INTEGER NOT NULL DEFAULT 0"],
    ["reconciliation_outcome", "TEXT"],
    ["reconciled_by", "TEXT"],
    ["coordinator_id", "TEXT"],
    ["result_json", "TEXT"],
    ["result_hash", "TEXT"],
  ] as const;
  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      db.exec(
        `ALTER TABLE logical_turn_effects ADD COLUMN ${name} ${type}`, // sqlite-allow-raw -- Fixed additive columns for the lazy v14 surface.
      );
    }
  }
}

/** Adds durable logical-turn/attempt tables on first use without a version bump. */
export function ensureOpenClawAgentLogicalTurnSchema(db: DatabaseSync): void {
  ensureLogicalTurnEffectColumns(db);
  db.exec(logicalTurnSchema.logicalTurn); // sqlite-allow-raw -- Canonical DDL for the additive lazy surface.
}
