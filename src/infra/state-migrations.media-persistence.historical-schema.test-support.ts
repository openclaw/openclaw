import fs from "node:fs";

/** Exact schema bytes from 509a5f0373764, independent of current runtime DDL. */
export function historicalV15AgentSchemaSql(): string {
  return fs.readFileSync(
    new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v15.sql", import.meta.url),
    "utf8",
  );
}

/** Exact schema bytes from v2026.7.2-beta.4, the first tagged agent schema v14. */
export function historicalV14AgentSchemaSql(): string {
  return fs.readFileSync(
    new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v14.sql", import.meta.url),
    "utf8",
  );
}
