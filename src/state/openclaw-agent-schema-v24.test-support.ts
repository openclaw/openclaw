import { readFileSync } from "node:fs";

// Frozen before schema 25 retired writer-validation triggers; never derive migration input from its target.
export const OPENCLAW_AGENT_SCHEMA_V24_SQL = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v24.sql", import.meta.url),
  "utf8",
);
