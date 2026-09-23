import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { withLegacySessionParticipantsSchema } from "./openclaw-agent-participants-migration.js";
import { AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL } from "./openclaw-agent-progress-card-schema.js";
import { withLegacyAgentStorageSchema } from "./openclaw-agent-storage-schema.js";

const SUGGESTIONS_SCHEMA_START = "CREATE TABLE IF NOT EXISTS session_suggestions (";

const sessionSharingSchema = extractSqliteTableSchema(
  AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL,
  "session_members",
  {
    endMarker: "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (",
    includeEndMarker: false,
    errorMessage: "OpenClaw agent session-sharing schema markers are missing.",
  },
);
const sessionSuggestionsStart = sessionSharingSchema.indexOf(SUGGESTIONS_SCHEMA_START);
if (sessionSuggestionsStart === -1) {
  throw new Error("OpenClaw agent session-suggestions schema marker is missing.");
}
export const AGENT_V14_SESSION_SHARING_SCHEMA_SQL = sessionSharingSchema.slice(
  0,
  sessionSuggestionsStart,
);
export const AGENT_V14_ADDITIVE_SCHEMA_SQL = sessionSharingSchema.slice(sessionSuggestionsStart);
export const AGENT_V14_CORE_SCHEMA_SQL = withLegacySessionParticipantsSchema(
  withLegacyAgentStorageSchema(
    AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL.replace(sessionSharingSchema, ""),
  ),
);
