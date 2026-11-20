import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export { AGENT_CODE_MODE_JOURNAL_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
export const AGENT_CODE_MODE_JOURNAL_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_SQL,
  "session_code_mode_journal",
  { endMarker: "-- END CODE MODE JOURNAL", includeEndMarker: false },
);
export function withoutAgentCodeModeJournal(schema: string): string {
  return schema.replace(`${AGENT_CODE_MODE_JOURNAL_SQL}-- END CODE MODE JOURNAL\n\n`, "");
}
const postgresObjects =
  /CREATE TABLE "session_code_mode_journal" \([\s\S]*?\n\);|CREATE UNIQUE INDEX "idx_agent_code_mode_journal_tool_call"[^;]+;|ALTER TABLE "session_code_mode_journal"[^;]+;/gu;
export function withoutAgentPostgresCodeModeJournal(schema: string): string {
  return schema.replace(new RegExp(`(?:${postgresObjects.source})\\n\\n`, "gu"), "");
}
export function agentCodeModeJournalPostgresMigration(schema: string): string {
  const objects = schema.match(postgresObjects);
  if (objects?.length !== 4) {
    throw new Error("Code Mode journal table, index or foreign keys are missing");
  }
  return objects.join("\n\n");
}
