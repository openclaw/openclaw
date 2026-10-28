import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const AGENT_CREATION_OPERATIONS_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_SQL,
  "session_creation_operations",
  { endMarker: "-- END SESSION CREATION OPERATIONS", includeEndMarker: false },
);

/** Preserve the exact schema text used by released SQLite admission contracts. */
export function withoutAgentCreationOperations(schema: string): string {
  return schema.replace(
    /\n-- Receipts outlive session deletion[\s\S]*?-- END SESSION CREATION OPERATIONS\n/u,
    "",
  );
}

const postgresCreationStatements =
  /CREATE TABLE "session_creation_operations" \([\s\S]*?\n\);|ALTER TABLE "session_creation_operations" [^\n]+|CREATE (?:UNIQUE )?INDEX "[^"]+" ON "session_creation_operations" [^\n]+/gu;

/** Earlier migrations must retain their exact predecessor catalog. */
export function withoutAgentPostgresCreationOperations(schema: string): string {
  return schema.replace(
    new RegExp("(?:" + postgresCreationStatements.source + ")(?:\\n\\n)?", "gu"),
    "",
  );
}

export function agentCreationOperationsPostgresMigration(schema: string): string {
  return (schema.match(postgresCreationStatements) ?? []).join("\n\n");
}
