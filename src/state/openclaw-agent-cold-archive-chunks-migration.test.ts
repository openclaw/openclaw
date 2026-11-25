import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION as target } from "./openclaw-agent-db-contract.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedAgentV30Schema,
} from "./schema-migration.test-support.js";

const predecessor = 36;
const scope = ["schema_meta", "session_transcript_cold_archive_chunks"];
const withFixture = migrationFixture({ seed, predecessor, target, scope });
const table = "session_transcript_cold_archive_chunks";

function seed(database: DatabaseSync, sourceVersion = predecessor): void {
  // SQLite 31–36 retired the revision triggers and otherwise kept the v30 layout.
  seedAgentV30Schema(database, sourceVersion);
  database.exec(`
    DROP TRIGGER memory_index_sources_revision_after_insert;
    DROP TRIGGER memory_index_sources_revision_after_update;
    DROP TRIGGER memory_index_sources_revision_after_delete;
    DROP TRIGGER memory_index_chunks_revision_after_insert;
    DROP TRIGGER memory_index_chunks_revision_after_update;
    DROP TRIGGER memory_index_chunks_revision_after_delete;
    PRAGMA foreign_keys = ON;
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:retained', 'hot', '{"sessionId":"hot","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('hot', 'agent:main:retained', 1, 1), ('cold', 'agent:main:retained', 1, 1);
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('hot', 1, ' {"type":"message","message":{"role":"user"}} ', 1);
    INSERT INTO session_transcript_cold_archives
      (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
       archive_bytes, last_seq, archived_at, storage, archive_blob)
      VALUES ('cold', 'generation', 'retained.jsonl.zst', '${"a".repeat(64)}',
        1, 7, 3, 1, 1, 'sqlite', X'0011FF');
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 1);
    CREATE TABLE local_plugin_store (key TEXT PRIMARY KEY, body BLOB) STRICT;
    INSERT INTO local_plugin_store VALUES ('retained', X'00FF');
    ANALYZE;
  `);
}

it.each([
  ["commit", 35],
  ["commit", predecessor],
  ["rollback", predecessor],
] as const)(
  "adds only the chunk table and publishes both schema markers atomically (%s, from %s)",
  async (outcome, sourceVersion) => {
    const withSource = migrationFixture({
      seed: (database) => seed(database, sourceVersion),
      predecessor: sourceVersion,
      target,
      scope,
    });
    await withSource("cold-chunks.sqlite", async ({ database, migrate }) => {
      // The fixture checks every undeclared table's typed contents and schema,
      // including retained hot/cold history, plugin data, and populated statistics.
      const witness = agentWitness(database);
      await migrate(outcome);
      expect(assertOpenClawMigrationWitnessPreserved(witness, agentWitness(database))).toEqual({
        warnings: [],
      });
      expectVersion(database, outcome === "rollback" ? sourceVersion : target);
      const definition = row(
        database,
        "SELECT strict, wr FROM pragma_table_list WHERE name = ?",
        table,
      );
      if (outcome === "rollback") {
        expect(definition).toBeUndefined();
        return;
      }
      expect(definition).toEqual({ strict: 1, wr: 1 });
      expect(rows(database, `SELECT * FROM ${table}`)).toEqual([]);
      database
        .prepare(`INSERT INTO ${table}
        (session_id, chunk_index, archive_name, archive_sha256, first_seq, last_seq,
         event_count, raw_bytes, archive_bytes, archive_blob)
        VALUES ('cold', 0, 'chunk.jsonl.zst', ?, 1, 1, 1, 7, 3, X'0011FF')`)
        .run("b".repeat(64));
      expect(() =>
        assertOpenClawMigrationWitnessPreserved(witness, agentWitness(database)),
      ).toThrow("Migration added unclassified database content");
      const withChunk = agentWitness(database);
      database.exec(`UPDATE ${table} SET archive_blob = X'FF1100'`);
      expect(() =>
        assertOpenClawMigrationWitnessPreserved(withChunk, agentWitness(database)),
      ).toThrow(`Migration changed or lost retained database content: ${table}`);
      database.exec("DELETE FROM session_transcript_cold_archives WHERE session_id = 'cold'");
      expect(rows(database, `SELECT * FROM ${table}`)).toEqual([]);
      expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
    });
  },
);

it("restores the scoped predecessor while retaining unrelated later writes", async () => {
  await withFixture(
    "cold-chunks-restore.sqlite",
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
