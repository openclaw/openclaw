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

/** Materialize distinct current databases without runtime handles, leases, or registrations. */
export function createCurrentOpenClawAgentDatabaseFixtures(
  templatePath: string,
  fixtures: ReadonlyArray<{ path: string; agentId: string }>,
): void {
  const template = openNodeSqliteDatabase(templatePath);
  try {
    runSqliteImmediateTransactionSync(template, () => {
      template.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      template.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
      persistAgentSchemaMetadata(template, "fixture-template", OPENCLAW_AGENT_SCHEMA_VERSION);
    });
  } finally {
    template.close();
  }
  for (const fixture of fixtures) {
    fs.mkdirSync(path.dirname(fixture.path), { recursive: true });
    fs.copyFileSync(templatePath, fixture.path, fs.constants.COPYFILE_EXCL);
    const database = openNodeSqliteDatabase(fixture.path);
    try {
      persistAgentSchemaMetadata(database, fixture.agentId, OPENCLAW_AGENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  }
}

/** Remove only the schema owner's future projection before carving a historical database. */
export function removeCanonicalValidationFromHistoricalAgentFixture(database: DatabaseSync): void {
  const definitions = [
    ...canonicalSessionValidationSchemaSql(OPENCLAW_AGENT_SCHEMA_V21_SQL).matchAll(
      /^CREATE (TABLE|TRIGGER) IF NOT EXISTS ([a-z_]+)\b/gm,
    ),
  ];
  // Drop triggers before their pending table; unrelated fixture dependents remain intact.
  for (const match of definitions.toReversed()) {
    const kind = match[1];
    const name = match[2];
    if ((kind !== "TABLE" && kind !== "TRIGGER") || typeof name !== "string") {
      throw new Error("Invalid canonical-validation schema fixture definition");
    }
    database.exec(`DROP ${kind} IF EXISTS "${name}"`);
  }
}

export function seedSchema19SessionKeyRepairFixture(database: DatabaseSync): void {
  removeCanonicalValidationFromHistoricalAgentFixture(database);
  database
    .prepare(
      `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      "agent:worker-1:session-1",
      "session-1",
      JSON.stringify({ sessionId: "session-1", updatedAt: 1 }),
      1,
    );
  database.exec(`
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

/** List process-held agent databases without opening or inspecting fixture state. */
export function listOpenClawAgentDatabasesForTest(): Array<{ agentId: string; path: string }> {
  return [...cache.databases.values()]
    .filter((database) => database.db.isOpen)
    .map((database) => ({ agentId: database.agentId, path: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.path.localeCompare(right.path),
    );
}

/** Model missing restart metadata without invoking the runtime invalidation owner. */
export function removeAgentIntegrityMetadataForTest(pathname: string): void {
  fs.rmSync(`${pathname}.seal`, { force: true });
}
