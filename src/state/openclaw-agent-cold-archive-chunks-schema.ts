import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const AGENT_COLD_ARCHIVE_CHUNKS_SQL = extractSqliteTableSchema(
  OPENCLAW_AGENT_SCHEMA_SQL,
  "session_transcript_cold_archive_chunks",
);

/** Earlier readers only understand one file per cold window. */
export function withoutAgentColdArchiveChunks(schema: string): string {
  return schema.replace(`${AGENT_COLD_ARCHIVE_CHUNKS_SQL}\n\n`, "");
}

/** Retain the exact predecessor catalog until the versioned PostgreSQL step runs. */
export function withoutAgentPostgresColdArchiveChunks(schema: string): string {
  return schema
    .replace(/CREATE TABLE "session_transcript_cold_archive_chunks" \([\s\S]*?\n\);\n\n/gu, "")
    .replace(/ALTER TABLE "session_transcript_cold_archive_chunks" [^\n]+\n\n/gu, "");
}

export function agentColdArchiveChunksPostgresMigration(schema: string): string {
  return (
    schema.match(
      /CREATE TABLE "session_transcript_cold_archive_chunks" \([\s\S]*?\n\);|ALTER TABLE "session_transcript_cold_archive_chunks" [^\n]+/gu,
    ) ?? []
  ).join("\n\n");
}
