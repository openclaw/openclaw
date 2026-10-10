// Additive meeting-transcript schema used by the feature's one-time lazy ensure.
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema.js";

export const ensureMeetingTranscriptsSchema = createOpenClawStateSchemaEnsurer({
  table: "meeting_transcript_sessions",
  additionalTables: ["meeting_transcript_utterances", "meeting_transcript_summaries"],
  indexes: [
    "idx_meeting_transcript_sessions_started",
    "idx_meeting_transcript_sessions_id",
    "idx_meeting_transcript_sessions_slug",
    "idx_meeting_transcript_sessions_export_key",
    "idx_meeting_transcript_utterances_id",
  ],
  endMarker: "  CHECK (summary_json IS NOT NULL OR markdown IS NOT NULL)\n) STRICT;\n",
  operationLabel: "meeting-transcripts.schema.ensure",
});
