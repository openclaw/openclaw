import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL } from "./openclaw-agent-board-schema.js";

export const SESSION_PROGRESS_CARDS_TABLE = "session_progress_cards";
export const AGENT_PROGRESS_CARD_SCHEMA_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL,
  SESSION_PROGRESS_CARDS_TABLE,
  {
    endMarker: "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (",
    includeEndMarker: false,
    errorMessage: "OpenClaw agent progress-card schema markers are missing.",
  },
);
export const AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL =
  OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL.replace(AGENT_PROGRESS_CARD_SCHEMA_SQL, "");

/** Ensure the additive progress-card table inside the caller's write transaction. */
export function ensureOpenClawAgentProgressCardSchemaInTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("progress-card schema ensure requires an active transaction");
  }
  db.exec(AGENT_PROGRESS_CARD_SCHEMA_SQL); // sqlite-allow-raw -- Canonical DDL bootstrap for the lazy progress-card schema.
}
