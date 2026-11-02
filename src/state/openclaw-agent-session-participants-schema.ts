import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { SESSION_PARTICIPANTS_TABLE } from "./openclaw-agent-db-contract.js";
import { sessionParticipantsSchemaSql } from "./openclaw-agent-schema-history.js";

export { sessionParticipantsSchemaSql } from "./openclaw-agent-schema-history.js";

const ensureNativeSessionParticipantsSchema = createSqliteSchemaEnsurer(
  sessionParticipantsSchemaSql,
  { tables: [SESSION_PARTICIPANTS_TABLE] },
);

export function ensureSessionParticipantsSchema(database: EngineConnection): void {
  // PostgreSQL admits the complete agent schema, including participants, at open.
  if (!isPostgresSqlConnection(database)) {
    ensureNativeSessionParticipantsSchema(database);
  }
}
