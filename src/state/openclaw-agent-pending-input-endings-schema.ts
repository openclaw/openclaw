import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

export { AGENT_PENDING_INPUT_ENDINGS_SCHEMA_VERSION } from "./openclaw-schema-versions.js";

export function withoutAgentPendingInputEndings(schema: string): string {
  return schema.replace("  end_cause TEXT,\n", "").replace("  origin_source_json TEXT,\n", "");
}

export function withoutAgentPostgresPendingInputEndings(schema: string): string {
  return schema
    .replace('  "end_cause" text COLLATE "C",\n', "")
    .replace('  "origin_source_json" text COLLATE "C",\n', "");
}

/** The versioned owner preserves accepted bytes and the optional table's first-use timing. */
export function migrateAgentPendingInputEndingsInTransaction(database: DatabaseSync): void {
  if (!tableExists(database, "session_pending_inputs")) {
    return;
  }
  ensureColumn(database, "session_pending_inputs", "end_cause TEXT");
  ensureColumn(database, "session_pending_inputs", "origin_source_json TEXT");
  // sqlite-allow-raw -- Versioned normalization of pre-end_cause plain-JSON retirement facts.
  database.exec(`UPDATE session_pending_inputs SET end_cause = 'user-stop'
    WHERE state = 'cancelled' AND end_cause IS NULL AND (
      json_type(message_json, '$.__openclaw.pendingInputCancelledByUser') = 'true'
      OR json_type(message_json, '$.display') = 'false'
    )`);
}

export const AGENT_PENDING_INPUT_ENDINGS_POSTGRES_MIGRATION_SQL = `
DO $pending_input_endings$
BEGIN
  IF to_regclass('session_pending_inputs') IS NOT NULL THEN
    ALTER TABLE session_pending_inputs ADD COLUMN end_cause TEXT COLLATE "C";
    ALTER TABLE session_pending_inputs ADD COLUMN origin_source_json TEXT COLLATE "C";
    UPDATE session_pending_inputs SET end_cause = 'user-stop'
      WHERE state = 'cancelled' AND end_cause IS NULL AND (
        message_json::jsonb #> '{__openclaw,pendingInputCancelledByUser}' = 'true'::jsonb
        OR message_json::jsonb -> 'display' = 'false'::jsonb
      );
  END IF;
END
$pending_input_endings$;
`;
