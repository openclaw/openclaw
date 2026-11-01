import type { DatabaseSync } from "node:sqlite";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { replaceSqliteTableDefinition } from "../infra/sqlite-schema-catalog.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import { extractSqliteTableSchema, normalizeSqlWhitespace } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

/** Historical schema witnesses keep the pre-navigation payload constraint. */
export function withoutAgentColdNavigation(schema: string): string {
  return schema.replace(
    /\s+OR \(\s+event_json IS NULL AND event_zstd IS NULL\s+AND event_utf8_bytes IS NOT NULL\s+AND event_utf8_bytes BETWEEN 1 AND 4194304\s+AND navigation_json IS NOT NULL\s+\)/u,
    "",
  );
}

export function withoutAgentPostgresColdNavigation(schema: string): string {
  return schema.replace(
    ' OR ("event_json" IS NULL AND "event_zstd" IS NULL AND "event_utf8_bytes" IS NOT NULL AND ("event_utf8_bytes" BETWEEN 1 AND 4194304) AND "navigation_json" IS NOT NULL)',
    "",
  );
}

export function agentColdNavigationPostgresMigration(schema: string): string {
  const constraint = schema.match(/ {2}CHECK \([^\n]*"event_zstd" IS NOT NULL[^\n]+/u)?.[0];
  if (!constraint) {
    throw new Error("Cold navigation payload constraint is missing");
  }
  return `ALTER TABLE "transcript_events" DROP CONSTRAINT "transcript_events_check";
    ALTER TABLE "transcript_events" ADD CONSTRAINT "transcript_events_check" ${constraint.trim().replace(/,$/u, "")};`;
}

/** The schema owner holds the migration transaction and exclusive maintenance custody. */
export function migrateAgentColdNavigationInTransaction(database: DatabaseSync): void {
  const table = "transcript_events";
  const schema = captureSqliteSchemaFacts(database);
  const source = schema.tableSql.get(table);
  if (!source) {
    throw new Error("Cold navigation migration requires the transcript table");
  }
  const canonical = extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, table);
  const nextCheck = parseSqliteTableDefinition(canonical, table).constraints.find((constraint) =>
    constraint.includes("event_zstd IS NOT NULL"),
  );
  if (!nextCheck) {
    throw new Error("Cold navigation payload constraint is missing");
  }
  const oldCheck = withoutAgentColdNavigation(nextCheck);
  const definition = normalizeSqlWhitespace(source);
  if (definition.includes(nextCheck)) {
    // Earlier version steps may have already rebuilt this table with the current definition.
    return;
  }
  if (!definition.includes(oldCheck)) {
    throw new Error("Cold navigation migration cannot identify the prior payload constraint");
  }
  // Match the stored SQL produced by the original CREATE/copy/RENAME migration.
  const target = definition
    .replace(
      /^CREATE TABLE (?:IF NOT EXISTS )?(?:"transcript_events"|transcript_events)/u,
      'CREATE TABLE "transcript_events"',
    )
    .replace(oldCheck, nextCheck);
  // Every existing row satisfies the stricter old CHECK; only the catalog needs changing.
  replaceSqliteTableDefinition(database, table, target);
}
