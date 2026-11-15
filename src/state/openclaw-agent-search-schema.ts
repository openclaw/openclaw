import type { SearchSchema } from "../infra/database-engine/contract.js";

export const agentTranscriptSearchSchema: SearchSchema = {
  text: {
    transcript: {
      table: "session_transcript_fts",
      fields: ["text"],
      postgres: { identity: "rowid" },
    },
  },
};

// PostgreSQL's derived content mirrors the native FTS columns without changing SQLite DDL.
export const AGENT_TRANSCRIPT_SEARCH_POSTGRES_SQL = `CREATE TABLE "session_transcript_fts" (
  "rowid" bigint PRIMARY KEY REFERENCES "session_transcript_fts_rows" ("id") ON DELETE CASCADE,
  "text" text COLLATE "C",
  "session_id" text COLLATE "C",
  "message_id" text COLLATE "C",
  "role" text COLLATE "C",
  "timestamp" double precision
);
`;
