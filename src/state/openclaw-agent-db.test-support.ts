import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { canonicalSessionValidationSchemaSql } from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { agentDatabaseLifecycle as cache } from "./openclaw-agent-db-lifecycle.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { OPENCLAW_AGENT_SCHEMA_V21_SQL } from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export function createCurrentOpenClawAgentDatabaseFixtures(
  templatePath: string,
  fixtures: ReadonlyArray<{ path: string; agentId: string }>,
): void {
  {
    using template = openNodeSqliteDatabase(templatePath);
    runSqliteImmediateTransactionSync(template, () => {
      template.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      template.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
      persistAgentSchemaMetadata(template, "fixture-template", OPENCLAW_AGENT_SCHEMA_VERSION);
    });
  }
  for (const fixture of fixtures) {
    fs.mkdirSync(path.dirname(fixture.path), { recursive: true });
    fs.copyFileSync(templatePath, fixture.path, fs.constants.COPYFILE_EXCL);
    using database = openNodeSqliteDatabase(fixture.path);
    persistAgentSchemaMetadata(database, fixture.agentId, OPENCLAW_AGENT_SCHEMA_VERSION);
  }
}

export function removeCanonicalValidationFromHistoricalAgentFixture(database: DatabaseSync): void {
  const definitions = canonicalSessionValidationSchemaSql(OPENCLAW_AGENT_SCHEMA_V21_SQL).matchAll(
    /^CREATE (?:TABLE|TRIGGER) IF NOT EXISTS [a-z_]+\b/gm,
  );
  // Drop triggers before their pending table.
  for (const [definition] of [...definitions].toReversed()) {
    database.exec(definition.replace("CREATE", "DROP").replace("IF NOT EXISTS", "IF EXISTS"));
  }
}

export function seedSchema19SessionKeyRepairFixture(database: DatabaseSync): void {
  removeCanonicalValidationFromHistoricalAgentFixture(database);
  database.exec(`
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:worker-1:session-1', 'session-1', '{"sessionId":"session-1","updatedAt":1}', 1);
    DROP TABLE session_transcript_cold_archives;
    PRAGMA user_version = 19;
    UPDATE schema_meta SET schema_version = 19 WHERE meta_key = 'primary';
    DROP TRIGGER session_nodes_entry_valid_after_insert;
    DROP TRIGGER session_nodes_entry_valid_after_entry_update;
    DROP TRIGGER session_nodes_entry_valid_after_identity_update;
    DROP TRIGGER session_conversations_route_context_invalidate_after_update;
    DROP INDEX idx_agent_session_nodes_entry_valid_pending;
    DROP INDEX idx_agent_session_nodes_entry_not_valid;
    DROP TABLE session_key_contract;
    ALTER TABLE session_nodes DROP COLUMN entry_valid;
    ALTER TABLE session_conversations DROP COLUMN route_context_json;
  `);
}

export function listOpenClawAgentDatabasesForTest(): Array<{ agentId: string; path: string }> {
  return [...cache.databases.values()]
    .filter((database) => database.db.isOpen)
    .map((database) => ({ agentId: database.agentId, path: database.path }))
    .toSorted((a, b) => a.agentId.localeCompare(b.agentId) || a.path.localeCompare(b.path));
}

export function removeAgentIntegrityMetadataForTest(pathname: string): void {
  fs.rmSync(`${pathname}.seal`, { force: true });
}

export function seedLegacyAgentFixture(database: DatabaseSync, agentId = "keeper"): void {
  const source = new URL(
    "../../test/fixtures/sqlite/openclaw-agent-v2026.9.9.sql",
    import.meta.url,
  );
  database.exec(fs.readFileSync(source, "utf8").replaceAll("keeper", agentId));
}

export function fixtureVolumeHasFileAlias(
  directory: string,
  filename: string,
  alias: string,
): boolean {
  const probePath = path.join(fs.realpathSync(directory), filename);
  fs.writeFileSync(probePath, "probe");
  try {
    const probe = fs.lstatSync(probePath, { bigint: true });
    const alternate = fs.lstatSync(path.join(path.dirname(probePath), alias), { bigint: true });
    return probe.dev === alternate.dev && probe.ino === alternate.ino;
  } catch {
    return false;
  }
}
