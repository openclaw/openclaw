import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { assertOpenClawMigrationWitnessPreserved as assertWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness as captureWitness,
  migrationFixture,
  row,
  rows,
  seedAgentV30Schema,
} from "./schema-migration.test-support.js";

const scope = ["schema_meta"];

function seed(database: DatabaseSync, predecessor: number): void {
  seedAgentV30Schema(database, predecessor);
  database.exec(`
    DROP TRIGGER memory_index_sources_revision_after_insert;
    DROP TRIGGER memory_index_sources_revision_after_update;
    DROP TRIGGER memory_index_sources_revision_after_delete;
    DROP TRIGGER memory_index_chunks_revision_after_insert;
    DROP TRIGGER memory_index_chunks_revision_after_update;
    DROP TRIGGER memory_index_chunks_revision_after_delete;
    PRAGMA foreign_keys = ON;
    INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('memory/retained.md', 'memory', 'source-hash', 1, 42);
    INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('retained', 'memory/retained.md', 'memory', 1, 2, 'chunk-hash', 'model',
        'retained 日本語', X'000000000000F03F0000000000000080', 1);
    INSERT INTO memory_index_chunk_recall_metadata (chunk_id, importance)
      VALUES ('retained', 7);
    INSERT INTO memory_index_chunk_provenance
      (chunk_id, origin_class, session_kind, observed_at)
      VALUES ('retained', 'owner', 'interactive', 1);
    INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('fixture', 'model', 'key', 'chunk-hash',
        X'000000000000F03F0000000000000080', 2, 1);
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 1);
    CREATE INDEX local_memory_source_hash ON memory_index_sources(hash);
    ANALYZE;
  `);
}

function retained(database: DatabaseSync) {
  return {
    sources: rows(database, "SELECT * FROM memory_index_sources ORDER BY path, source"),
    chunks: rows(database, "SELECT * FROM memory_index_chunks ORDER BY id"),
    recall: rows(database, "SELECT * FROM memory_index_chunk_recall_metadata ORDER BY chunk_id"),
    provenance: rows(database, "SELECT * FROM memory_index_chunk_provenance ORDER BY chunk_id"),
    embeddings: rows(database, "SELECT * FROM memory_embedding_cache ORDER BY hash"),
    revision: row(database, "SELECT revision FROM memory_index_state WHERE id = 1"),
    layout: rows(database, "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name"),
    statistics: rows(database, "SELECT * FROM sqlite_stat1 ORDER BY tbl, idx"),
    userVersion: row(database, "PRAGMA user_version")?.user_version,
    schemaVersion: row(database, "SELECT schema_version FROM schema_meta")?.schema_version,
  };
}

describe.each([
  [31, 32],
  [32, 33],
])("PostgreSQL search metadata %s→%s", (predecessor, target) => {
  const withFixture = migrationFixture({
    seed: (db) => seed(db, predecessor),
    predecessor,
    target,
    scope,
    admission: target === OPENCLAW_AGENT_SCHEMA_VERSION,
  });
  it.each(["commit", "rollback"] as const)(
    "keeps SQLite rows, indexes and statistics unchanged (%s)",
    async (outcome) => {
      await withFixture(
        "vector-decoder.sqlite",
        async ({ database, migrate }) => {
          const before = retained(database);
          const witness = captureWitness(database);
          await migrate(outcome);
          const version = outcome === "rollback" ? predecessor : target;
          expect(retained(database)).toEqual({
            ...before,
            userVersion: version,
            schemaVersion: version,
          });
          expect(assertWitnessPreserved(witness, captureWitness(database))).toEqual({
            warnings: [],
          });
          expect(row(database, "SELECT hex(blob) AS bytes FROM cache_entries")).toEqual({
            bytes: "000100FF",
          });
          expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
        },
        "state",
      );
    },
  );

  it("restores only SQLite migration metadata while preserving later unrelated writes", async () => {
    await withFixture(
      "vector-decoder-restore.sqlite",
      async ({ database, restore }) => {
        await restore(() => retained(database));
      },
      "state",
    );
  });
});
