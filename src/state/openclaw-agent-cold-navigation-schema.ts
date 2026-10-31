import type { DatabaseSync } from "node:sqlite";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import {
  extractSqliteTableSchema,
  normalizeSqlWhitespace,
  quoteSqliteIdentifier,
} from "../infra/sqlite-schema-sql.js";
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

/** The schema owner holds the transaction with FK enforcement disabled for this table rebuild. */
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
  const temporary = "transcript_events_cold_navigation_migration";
  const columns = [...parseSqliteTableDefinition(source, table).columns.keys()]
    .map(quoteSqliteIdentifier)
    .join(", ");
  const target = definition
    .replace(
      /^CREATE TABLE (?:IF NOT EXISTS )?(?:"transcript_events"|transcript_events)/u,
      `CREATE TABLE ${temporary}`,
    )
    .replace(oldCheck, nextCheck);
  // sqlite-allow-raw: Structural migration preserves native rowids and the admitted table definition.
  database.exec(`${target};
    INSERT INTO ${temporary} (rowid, ${columns}) SELECT rowid, ${columns} FROM transcript_events;
    DROP TABLE transcript_events;
    ALTER TABLE ${temporary} RENAME TO transcript_events;`);
  for (const object of [...schema.indexDefinitions.values(), ...schema.triggers.values()]) {
    if (object.table === table && typeof object.sql === "string") {
      // sqlite-allow-raw: Replay only the admitted table's own index/trigger definitions.
      database.exec(object.sql);
    }
  }
}
