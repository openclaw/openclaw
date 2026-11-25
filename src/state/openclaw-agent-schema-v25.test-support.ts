import { readFileSync } from "node:fs";

// Frozen before schema 26 promoted JSON predicates; migration input must not follow its target.
export const OPENCLAW_AGENT_SCHEMA_V25_SQL = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v25.sql", import.meta.url),
  "utf8",
);
