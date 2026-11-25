import { readFileSync } from "node:fs";
import { checkedFrozenText } from "./openclaw-historical-imports.test-support.js";

export const OPENCLAW_AGENT_SCHEMA_V26_SQL = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v26.sql", import.meta.url),
  "utf8",
);

// Pin the pre-promotion v25 bytes so the input cannot follow its v26 migration target.
export const OPENCLAW_AGENT_SCHEMA_V25_SQL = checkedFrozenText(
  OPENCLAW_AGENT_SCHEMA_V26_SQL.replace("  session_started_at INTEGER,\n", "")
    .replace("  has_optional_references INTEGER NOT NULL DEFAULT 0,\n", "")
    .replace("  row_transcript_json TEXT,\n  row_transcript_updated_at INTEGER,\n", "")
    .replace(
      /^ {2}navigation_type TEXT,\n[\s\S]*?^ {2}navigation_valid INTEGER NOT NULL DEFAULT 1,\n/mu,
      "",
    )
    .replace("  payload_state TEXT,\n", ""),
  "agent v25",
  "287a109afc7b49a9f6cb9d9789674d143d7ce78bbef8d3ef0dce8c8723ec8470",
);

// The released v27 outbox adds an enqueue-order primary key.
export const OPENCLAW_AGENT_SCHEMA_V27_SQL = checkedFrozenText(
  OPENCLAW_AGENT_SCHEMA_V26_SQL.replace(
    "  advancement_key TEXT NOT NULL PRIMARY KEY,\n",
    "  enqueue_sequence INTEGER PRIMARY KEY,\n  advancement_key TEXT NOT NULL UNIQUE,\n",
  ),
  "agent v27",
  "227fcd299f5dfd3012abd0f110cd028ba6add9155bc74e2e558aadeae2761349",
);
