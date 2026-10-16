import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { SESSION_PARTICIPANTS_TABLE } from "./openclaw-agent-db-contract.js";
import { sessionParticipantsSchemaSql } from "./openclaw-agent-schema-history.js";

export { sessionParticipantsSchemaSql } from "./openclaw-agent-schema-history.js";

export const ensureSessionParticipantsSchema = createSqliteSchemaEnsurer(
  sessionParticipantsSchemaSql,
  { tables: [SESSION_PARTICIPANTS_TABLE] },
);
