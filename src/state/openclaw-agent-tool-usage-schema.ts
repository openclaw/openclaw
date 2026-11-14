import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export { AGENT_TOOL_USAGE_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
export const AGENT_TOOL_USAGE_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_SQL,
  "agent_tool_usage",
  { endMarker: "-- END AGENT TOOL USAGE", includeEndMarker: false },
);

export function withoutAgentToolUsage(schema: string): string {
  return schema.replace(`${AGENT_TOOL_USAGE_SQL}-- END AGENT TOOL USAGE\n\n`, "");
}

const postgresTable = /CREATE TABLE "agent_tool_usage" \([\s\S]*?\n\);/u;

export function withoutAgentPostgresToolUsage(schema: string): string {
  return schema.replace(new RegExp(`${postgresTable.source}\\n\\n`, "u"), "");
}

export function agentToolUsagePostgresMigration(schema: string): string {
  const table = schema.match(postgresTable)?.[0];
  if (!table) {
    throw new Error("Agent tool usage table is missing");
  }
  return table;
}
