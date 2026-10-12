import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { SESSION_PARTICIPANTS_TABLE } from "./openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export function sessionParticipantsSchemaSql(): string {
  return extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_PARTICIPANTS_TABLE, {
    endMarker: "CREATE TABLE IF NOT EXISTS session_key_contract (",
    includeEndMarker: false,
    errorMessage: "OpenClaw session participant schema markers are missing.",
  });
}

export const ensureSessionParticipantsSchema = createSqliteSchemaEnsurer(
  sessionParticipantsSchemaSql,
  { tables: [SESSION_PARTICIPANTS_TABLE] },
);
