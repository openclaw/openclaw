import fs from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { createScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease as withLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  assertOpenClawMigrationWitnessPreserved as assertWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved as assertScope } from "./sqlite-migration-scope.test-support.js";

const predecessor = 30;
const target = 31;
const scope = ["memory_index_chunks", "memory_index_sources", "schema_meta"];
const rows = (database: DatabaseSync, sql: string) => database.prepare(sql).all();
const row = (database: DatabaseSync, sql: string) => database.prepare(sql).get();
const statistics = (database: DatabaseSync) =>
  rows(database, "SELECT * FROM sqlite_stat1 ORDER BY tbl, idx");
const captureWitness = (database: DatabaseSync) =>
  captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" });

function migrate(database: DatabaseSync, pathname: string, env: NodeJS.ProcessEnv) {
  ensureOpenClawAgentDatabaseSchema(database, { agentId: "main", env, path: pathname });
}
// Frozen schema plus the previously published bundle DDL, independent of the new migration.
const schemaV27 = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v27.sql", import.meta.url),
  "utf8",
);

function seed(database: DatabaseSync): void {
  database.exec(schemaV27);
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
    PRAGMA user_version = ${predecessor};
    PRAGMA foreign_keys = ON;
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', ${predecessor}, 'main', 1, 1);
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.statePath("memory-revision.sqlite");
      using database = new DatabaseSync(pathname);
      seed(database);
      const before = retained(database);
      const witness = captureWitness(database);
      expect(before.layout.filter((entry) => entry.type === "trigger")).toHaveLength(6);
      if (outcome === "rollback") {
        database.setAuthorizer((action, name, value) =>
          action === constants.SQLITE_PRAGMA && name === "user_version" && value === String(target)
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        );
      }
      await withLease({ env: state.env }, async () => {
        await assertScope(database, scope, () => {
          const run = () => migrate(database, pathname, state.env);
          if (outcome === "rollback") {
            expect(run).toThrow(/authoriz/u);
          } else {
            run();
          }
        });
      });
      database.setAuthorizer(null);
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
    });
  },
);

it("restores historical triggers while retaining later unrelated writes and statistics", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.statePath("memory-revision-restore.sqlite");
    const backupPath = state.statePath("memory-revision.scoped.bak");
    using database = new DatabaseSync(pathname);
    seed(database);
    const before = retained(database);
    const originalStatistics = statistics(database);
    expect(
      resolveSchemaMigrationBackupTables({
        kind: "agent",
        foundVersion: predecessor,
        supportedVersion: target,
      }),
    ).toEqual(scope);
    await withLease({ env: state.env }, async (lease) => {
      await createScopedMigrationSnapshot({
        sourcePath: pathname,
        targetPath: backupPath,
        tables: scope,
        beforePublish: () => lease.assertOwned(),
      });
      migrate(database, pathname, state.env);
    });
    database.exec("UPDATE cache_entries SET blob = X'BEEF' WHERE scope = 'unrelated'");
    await assertScope(database, scope, () =>
      restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env: state.env }),
    );
    expect(retained(database)).toEqual(before);
    expect(statistics(database)).toEqual(originalStatistics);
    expect(row(database, "SELECT hex(blob) AS bytes FROM cache_entries")?.bytes).toBe("BEEF");
    database.exec("UPDATE memory_index_chunks SET text = 'old-writer-update'");
    expect(row(database, "SELECT revision FROM memory_index_state WHERE id = 1")).toEqual({
      revision: 3,
    });
  });
});
