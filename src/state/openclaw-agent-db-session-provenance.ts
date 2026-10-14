import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

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
