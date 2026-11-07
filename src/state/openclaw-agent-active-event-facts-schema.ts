import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export { AGENT_ACTIVE_EVENT_FACTS_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
export const AGENT_ACTIVE_EVENT_FACTS_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_SQL,
  "session_transcript_active_event_facts",
  { endMarker: "-- END ACTIVE EVENT FACTS", includeEndMarker: false },
);

/** Older writers do not maintain these facts and must keep their original schema contract. */
export function withoutAgentActiveEventFacts(schema: string): string {
  return schema.replace(`${AGENT_ACTIVE_EVENT_FACTS_SQL}-- END ACTIVE EVENT FACTS\n\n`, "");
}

const postgresObjects =
  /CREATE TABLE "session_transcript_active_event_facts" \([\s\S]*?\n\);|ALTER TABLE "session_transcript_active_event_facts"[^;]+;/gu;

export function withoutAgentPostgresActiveEventFacts(schema: string): string {
  return schema.replace(new RegExp(`(?:${postgresObjects.source})\\n\\n`, "gu"), "");
}

export function agentActiveEventFactsPostgresMigration(schema: string): string {
  const objects = schema.match(postgresObjects);
  if (objects?.length !== 2) {
    throw new Error("Active event facts table or foreign key is missing");
  }
  return objects.join("\n\n");
}
