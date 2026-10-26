import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  migrationFixture,
  row,
  rows,
  seedAgentV30Schema,
} from "./schema-migration.test-support.js";

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

const retained = (db: DatabaseSync) =>
  ["PRAGMA user_version", "SELECT schema_version FROM schema_meta"].map((sql) => row(db, sql));

describe.each([
  [31, 32],
  [32, 33],
])("PostgreSQL search metadata %s→%s", (predecessor, target) => {
  const withFixture = migrationFixture({
    seed: (db) => seed(db, predecessor),
    predecessor,
    target,
    scope: ["schema_meta"],
  });
  it.each(["commit", "rollback", "restore"] as const)(
    "keeps SQLite rows, indexes and statistics unchanged (%s)",
    async (outcome) => {
      await withFixture(
        "vector-decoder.sqlite",
        async ({ database, migrate, restore }) => {
          if (outcome === "restore") {
            await restore(() => retained(database));
            return;
          }
          await migrate(outcome);
          const version = outcome === "rollback" ? predecessor : target;
          expect(retained(database)).toEqual([
            { user_version: version },
            { schema_version: version },
          ]);
          expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
        },
        "state",
      );
    },
  );
});
