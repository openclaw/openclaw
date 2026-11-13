import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const AGENT_CREATION_OPERATIONS_SCHEMA_VERSION = 40;
export const SESSION_CREATION_OPERATIONS_TABLE = "session_creation_operations";
export const AGENT_CREATION_OPERATIONS_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_SQL,
  SESSION_CREATION_OPERATIONS_TABLE,
  { endMarker: "-- END SESSION CREATION OPERATIONS", includeEndMarker: false },
);

/** Keep pre-receipt admission and rollback witnesses at their original schema. */
export function withoutAgentCreationOperations(schema: string): string {
  return schema.replace(
    `${AGENT_CREATION_OPERATIONS_SQL}-- END SESSION CREATION OPERATIONS\n\n`,
    "",
  );
}

// Agent40 also adopts the SQLite-only deletion indexes deferred by the PostgreSQL generator.
// Strip all four objects when admitting a pre40 sealed catalog.
const postgresObjects =
  /CREATE TABLE "session_creation_operations" \([\s\S]*?\n\);|CREATE INDEX "idx_agent_(?:session_creation_operations_expiry|session_input_completions_session_key|conversation_deliveries_source_session)"[^;]+;/gu;

export function withoutAgentPostgresCreationOperations(schema: string): string {
  return schema.replace(new RegExp(`(?:${postgresObjects.source})\\n\\n`, "gu"), "");
}

export function agentCreationOperationsPostgresMigration(schema: string): string {
  const objects = schema.match(postgresObjects);
  if (objects?.length !== 4) {
    throw new Error("Session creation receipt table or schema-40 index is missing");
  }
  return objects.join("\n\n");
}
