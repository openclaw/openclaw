import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_TRANSCRIPT_ARCHIVES_TABLE = "session_transcript_archives";

/** Lazily installs the additive canonical archive owner on first archive use. */
export const ensureSessionTranscriptArchiveSchema = createSqliteSchemaEnsurer(
  () =>
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_TRANSCRIPT_ARCHIVES_TABLE, {
      endMarker: "CREATE TABLE IF NOT EXISTS transcript_rewrite_watermarks (",
      includeEndMarker: false,
      errorMessage: "OpenClaw session transcript archive schema markers are missing.",
    }),
  {
    tables: [SESSION_TRANSCRIPT_ARCHIVES_TABLE, "session_transcript_cold_archives"],
    indexes: [
      "idx_agent_session_transcript_archives_pending",
      "idx_agent_session_transcript_archives_retention",
    ],
  },
);
