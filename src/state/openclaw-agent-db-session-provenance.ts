import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export function addSessionProvenanceColumns(
  db: DatabaseSync,
  columns: ReadonlySet<string> | null | undefined,
): void {
  if (columns && !columns.has("session_entry_provenance")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN session_entry_provenance INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1));",
    );
  }
  if (columns && !columns.has("acp_owned")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN acp_owned INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1));",
    );
  }
  if (columns && !columns.has("plugin_owner_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN plugin_owner_id TEXT;");
  }
  if (columns && !columns.has("hook_external_content_source")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN hook_external_content_source TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook'));",
    );
  }
}

export function backfillTranscriptMutationWatermarks(db: DatabaseSync): void {
  if (!tableExists(db, "transcript_events")) {
    return;
  }
  db.exec(`
    UPDATE sessions
    SET
      transcript_updated_at = COALESCE(
        transcript_updated_at,
        (SELECT MAX(transcript_events.created_at)
         FROM transcript_events
         WHERE transcript_events.session_id = sessions.session_id)
      ),
      transcript_observed_at = COALESCE(transcript_observed_at, updated_at)
    WHERE EXISTS (
      SELECT 1 FROM transcript_events
      WHERE transcript_events.session_id = sessions.session_id
    );
  `);
}
