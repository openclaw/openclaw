import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { AGENT_COLD_ARCHIVE_CHUNKS_SQL } from "./openclaw-agent-cold-archive-chunks-schema.js";
import { AGENT_CREATION_OPERATIONS_SCHEMA_VERSION as target } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedAgentV30Schema,
  seedVersion,
} from "./schema-migration.test-support.js";

const predecessor = 38;
const table = "session_creation_operations";
const scope = ["schema_meta", table];
const withFixture = migrationFixture({ seed, predecessor, target, scope });

function seed(database: DatabaseSync): void {
  // Published SQLite 31 retired these triggers; 37 added cold archive chunks.
  // The frozen v27 fixture + existing published transitions is independent of v39.
  seedAgentV30Schema(database, predecessor);
  database.exec(AGENT_COLD_ARCHIVE_CHUNKS_SQL);
  database.exec(`
    DROP TRIGGER memory_index_sources_revision_after_insert;
    DROP TRIGGER memory_index_sources_revision_after_update;
    DROP TRIGGER memory_index_sources_revision_after_delete;
    DROP TRIGGER memory_index_chunks_revision_after_insert;
    DROP TRIGGER memory_index_chunks_revision_after_update;
    DROP TRIGGER memory_index_chunks_revision_after_delete;
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:retained', 'retained', '{"sessionId":"retained","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('retained', 'agent:main:retained', 1, 1);
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('retained', 1, ' {"type":"message","message":{"role":"user","content":"unchanged"}} ', 1);
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 1);
    CREATE TABLE local_plugin_store (key TEXT PRIMARY KEY, body BLOB) STRICT;
    INSERT INTO local_plugin_store VALUES ('retained', X'00FF');
    ANALYZE;
  `);
}

it.each(["commit", "rollback"])(
  "adds only creation receipts and publishes both markers atomically (%s)",
  async (outcome) => {
    await withFixture("creation-receipts.sqlite", async ({ database, migrate }) => {
      const witness = agentWitness(database);
      await migrate(outcome);
      expect(assertOpenClawMigrationWitnessPreserved(witness, agentWitness(database))).toEqual({
        warnings: [],
      });
      expectVersion(database, outcome === "rollback" ? predecessor : target);
      const definition = row(database, "SELECT sql FROM sqlite_schema WHERE name = ?", table);
      if (outcome === "rollback") {
        expect(definition).toBeUndefined();
        return;
      }
      expect(definition).toBeDefined();
      expect(rows(database, "SELECT * FROM session_creation_operations")).toEqual([]);
      expect(rows(database, "PRAGMA foreign_key_list(session_creation_operations)")).toEqual([]);
      database
        .prepare("INSERT INTO session_creation_operations VALUES (?, ?, ?, ?)")
        .run("operation", "intent", "retained", 1000);
      expect(() =>
        database
          .prepare("INSERT INTO session_creation_operations VALUES (?, ?, ?, ?)")
          .run("other", "intent", "retained", 1000),
      ).toThrow(/UNIQUE/);
      database.exec("DELETE FROM session_nodes WHERE session_key = 'agent:main:retained'");
      expect(rows(database, "SELECT session_id FROM session_creation_operations")).toEqual([
        { session_id: "retained" },
      ]);
    });
  },
);

it("restores the pre-upgrade backup without discarding unrelated later writes", async () => {
  await withFixture(
    "creation-receipts-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => ({
        definition: row(database, "SELECT sql FROM sqlite_schema WHERE name = ?", table),
        userVersion: row(database, "PRAGMA user_version"),
        schemaVersion: row(database, "SELECT schema_version FROM schema_meta"),
      }));
    },
    "state",
  );
});

// This frozen fixture is byte-identical to v2026.10.8's canonical agent schema
// (SHA-256 287a109afc7b49a9f6cb9d9789674d143d7ce78bbef8d3ef0dce8c8723ec8470).
const stableSchema = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v25.sql", import.meta.url),
  "utf8",
);
it("upgrades the latest stable agent schema with a verified full pre-upgrade recovery copy", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const source = state.path("stable-agent.sqlite");
    const backup = state.path("stable-agent.backup.sqlite");
    const restored = state.path("stable-agent.restored.sqlite");
    using database = new DatabaseSync(source);
    database.exec(stableSchema);
    seedVersion(database, 25);
    database.exec(
      "INSERT INTO cache_entries (scope, key, blob, updated_at) VALUES ('retained', 'bytes', X'000100FF', 1)",
    );
    const before = agentWitness(database);
    // This older route deliberately retains full-file recovery; do not invent a
    // scoped table inventory for migration steps that never declared one.
    expect(
      resolveSchemaMigrationBackupTables({
        kind: "agent",
        foundVersion: 25,
        supportedVersion: target,
      }),
    ).toBeUndefined();
    await withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
      await createVerifiedSqliteSnapshot({
        sourcePath: source,
        targetPath: backup,
        preserveRowIds: true,
        beforePublish: () => lease.assertOwned(),
      });
      ensureOpenClawAgentDatabaseSchema(database, {
        agentId: "main",
        path: source,
        env: state.env,
      });
    });
    expectVersion(database, target);
    expect(assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toEqual({
      warnings: [],
    });
    await createVerifiedSqliteSnapshot({
      sourcePath: backup,
      targetPath: restored,
      preserveRowIds: true,
    });
    using recovery = new DatabaseSync(restored, { readOnly: true });
    expectVersion(recovery, 25);
    expect(agentWitness(recovery)).toEqual(before);
    expect(
      row(recovery, "SELECT hex(blob) AS bytes FROM cache_entries WHERE scope = 'retained'"),
    ).toEqual({ bytes: "000100FF" });
  }));
