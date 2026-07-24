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

/** Adds durable logical-turn/attempt tables on first use without a version bump. */
export function ensureOpenClawAgentLogicalTurnSchema(db: DatabaseSync): void {
  db.exec(logicalTurnSchema.logicalTurn); // sqlite-allow-raw -- Canonical DDL for the additive lazy surface.
}
