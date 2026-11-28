import { readFileSync } from "node:fs";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "./openclaw-agent-schema-v25.test-support.js";
import { checkedFrozenText, frozenSqlSection } from "./openclaw-historical-imports.test-support.js";

const v21 = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v21.sql", import.meta.url),
  "utf8",
);
const windows = "CREATE TABLE IF NOT EXISTS session_windows (";
const conversations = "CREATE TABLE IF NOT EXISTS conversations (";

// Restore the released v24 trigger definitions, including the original queue comment.
export const OPENCLAW_AGENT_SCHEMA_V24_SQL = checkedFrozenText(
  OPENCLAW_AGENT_SCHEMA_V25_SQL.replace(
    windows,
    frozenSqlSection(
      v21,
      "CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_insert",
      windows,
    ) + windows,
  ).replace(
    frozenSqlSection(
      OPENCLAW_AGENT_SCHEMA_V25_SQL,
      "-- Offline imports and repairs queue explicit work",
      conversations,
    ),
    frozenSqlSection(v21, "-- No foreign key: node triggers", conversations),
  ),
  "agent v24",
  "dde8e6165f12b428f9fdbae0e8e4ce4d76802fc2f6f0443232b7a303bd6fe087",
);
