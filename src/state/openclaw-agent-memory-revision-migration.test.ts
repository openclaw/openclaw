import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { assertOpenClawMigrationWitnessPreserved as assertWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness as captureWitness,
  migrationFixture,
  row,
  rows,
  seedVersion,
} from "./schema-migration.test-support.js";

const predecessor = 30;
const target = OPENCLAW_AGENT_SCHEMA_VERSION;
const scope = ["memory_index_chunks", "memory_index_sources", "schema_meta"];

const withFixture = migrationFixture({ seed, predecessor, target, scope, admission: true });
// Frozen schema plus the previously published bundle DDL, independent of the new migration.
const schemaV27 = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v27.sql", import.meta.url),
  "utf8",
);

function seed(database: DatabaseSync): void {
  database.exec(schemaV27);
  seedVersion(database, predecessor);
  database.exec(`
    DROP INDEX idx_agent_transcript_event_parent;
    DROP INDEX idx_agent_session_windows_conversation;
    CREATE INDEX idx_agent_session_windows_conversation
      ON session_windows(primary_conversation_id) WHERE primary_conversation_id IS NOT NULL;
    DROP TABLE memory_entry_origins;
    ${extractSqliteTableSchema(schemaV27, "memory_entry_origins").replace(
      ") STRICT;",
      ") STRICT, WITHOUT ROWID;",
    )}
    DROP INDEX idx_agent_session_nodes_last_interaction_at;
    DROP INDEX idx_agent_session_reactions_message;
    ALTER TABLE trajectory_runtime_events ADD COLUMN event_utf8_bytes INTEGER;
    ALTER TABLE trajectory_runtime_events ADD COLUMN event_payload BLOB;
    ALTER TABLE trajectory_runtime_events ADD COLUMN event_codec TEXT;
    DROP INDEX idx_agent_trajectory_runtime_run;
    CREATE INDEX idx_agent_trajectory_runtime_run
      ON trajectory_runtime_events(session_id, run_id, created_at,
        COALESCE(event_utf8_bytes, octet_length(event_json)));
    PRAGMA foreign_keys = ON;
    INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('memory/retained.md', 'memory', 'source-hash', 1, 42);
    INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('retained', 'memory/retained.md', 'memory', 1, 2, 'chunk-hash', 'model',
        'retained 日本語', X'0000803F', 1);
    INSERT INTO memory_index_chunk_recall_metadata (chunk_id, importance)
      VALUES ('retained', 7);
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 1);
    CREATE INDEX local_memory_source_hash ON memory_index_sources(hash);
    ANALYZE;
  `);
}

function layout(database: DatabaseSync) {
  return database
    .prepare(`SELECT type, name, sql FROM sqlite_schema
      WHERE tbl_name IN ('memory_index_sources', 'memory_index_chunks') ORDER BY type, name`)
    .all();
}

function retained(database: DatabaseSync) {
  return {
    sources: rows(database, "SELECT * FROM memory_index_sources ORDER BY path, source"),
    chunks: rows(database, "SELECT * FROM memory_index_chunks ORDER BY id"),
    revision: row(database, "SELECT revision FROM memory_index_state WHERE id = 1"),
    layout: layout(database),
    userVersion: row(database, "PRAGMA user_version")?.user_version,
    schemaVersion: row(database, "SELECT schema_version FROM schema_meta")?.schema_version,
  };
}

it.each(["commit", "rollback"] as const)(
  "preserves rows, sibling tables and atomic schema publication (%s)",
  async (outcome) => {
    await withFixture(
      "memory-revision.sqlite",
      async ({ database, migrate }) => {
        const before = retained(database);
        const witness = captureWitness(database);
        expect(before.layout.filter((entry) => entry.type === "trigger")).toHaveLength(6);
        await migrate(outcome);
        expect(assertWitnessPreserved(witness, captureWitness(database))).toEqual({
          warnings: [],
        });
        const expectedVersion = outcome === "rollback" ? predecessor : target;
        expect(retained(database)).toEqual({
          ...before,
          userVersion: expectedVersion,
          schemaVersion: expectedVersion,
          layout:
            outcome === "rollback"
              ? before.layout
              : before.layout.filter((entry) => entry.type !== "trigger"),
        });
        expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
      },
      "state",
    );
  },
);

it("restores historical triggers while retaining later unrelated writes and statistics", async () => {
  await withFixture(
    "memory-revision-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => retained(database));
      database.exec("UPDATE memory_index_chunks SET text = 'old-writer-update'");
      expect(row(database, "SELECT revision FROM memory_index_state WHERE id = 1")).toEqual({
        revision: 3,
      });
    },
    "state",
  );
});
