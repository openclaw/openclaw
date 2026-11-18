import fs from "node:fs";
import { constants, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect } from "vitest";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { createScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  ensureOpenClawAgentDatabaseSchema,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import { captureOpenClawMigrationWitness } from "./openclaw-migration-witness.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

export const row = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).get(...params);
export const rows = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).all(...params);
const statistics = (db: DatabaseSync) => rows(db, "SELECT * FROM sqlite_stat1 ORDER BY tbl, idx");
export const agentWitness = (db: DatabaseSync) =>
  captureOpenClawMigrationWitness(db, { role: "agent", agentId: "main" });

export function expectVersion(db: DatabaseSync, version: number) {
  expect(row(db, "PRAGMA user_version")).toEqual({ user_version: version });
  expect(row(db, "SELECT schema_version FROM schema_meta")).toEqual({ schema_version: version });
}

export function seedVersion(db: DatabaseSync, version: number) {
  db.exec(`PRAGMA user_version = ${version};
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', ${version}, 'main', 1, 1);`);
}

// Frozen v27 plus published v28–30 DDL, independent of the candidate migration.
const schemaV27 = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v27.sql", import.meta.url),
  "utf8",
);

export function seedAgentV30Schema(database: DatabaseSync, version: number): void {
  database.exec(schemaV27);
  seedVersion(database, version);
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
  `);
}

/** Frozen v27 plus released v28–37 DDL, independent of the schema-39 payload constraint. */
export function seedAgentV38Schema(database: DatabaseSync): void {
  seedAgentV30Schema(database, 38);
  database.exec(`
    DROP TRIGGER memory_index_sources_revision_after_insert;
    DROP TRIGGER memory_index_sources_revision_after_update;
    DROP TRIGGER memory_index_sources_revision_after_delete;
    DROP TRIGGER memory_index_chunks_revision_after_insert;
    DROP TRIGGER memory_index_chunks_revision_after_update;
    DROP TRIGGER memory_index_chunks_revision_after_delete;
    CREATE TABLE session_transcript_cold_archive_chunks (
      session_id TEXT NOT NULL, chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      archive_name TEXT NOT NULL UNIQUE, archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
      first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL CHECK (last_seq >= first_seq),
      event_count INTEGER NOT NULL CHECK (event_count >= 1), raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0),
      archive_bytes INTEGER NOT NULL CHECK (archive_bytes >= 0), archive_blob BLOB,
      PRIMARY KEY (session_id, chunk_index),
      FOREIGN KEY (session_id) REFERENCES session_transcript_cold_archives(session_id) ON DELETE CASCADE,
      CHECK (length(archive_name) > 0 AND archive_name NOT IN ('.', '..') AND archive_name NOT LIKE '%/%' AND archive_name NOT LIKE '%\\%')
    ) STRICT, WITHOUT ROWID;
  `);
}

export function refuseVersion(db: DatabaseSync, version: number) {
  db.setAuthorizer((action, name, value) =>
    action === constants.SQLITE_PRAGMA && name === "user_version" && value === String(version)
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
}

type MigrationFixture = {
  database: DatabaseSync;
  migrate: (outcome?: string) => Promise<void>;
  restore: (capture: () => unknown) => Promise<void>;
};

export function migrationFixture(config: {
  seed: (database: DatabaseSync) => void;
  predecessor: number;
  target: number;
  scope: string[];
  admission?: boolean;
}) {
  return (
    filename: string,
    run: (fixture: MigrationFixture) => Promise<void>,
    location: "root" | "state" = "root",
  ) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = location === "state" ? state.statePath(filename) : state.path(filename);
      using database = new DatabaseSync(pathname);
      config.seed(database);
      const { env } = state;
      const { scope, predecessor, target } = config;
      const withLease = (operation: Parameters<typeof withAgentDatabaseMaintenanceLease>[1]) =>
        withAgentDatabaseMaintenanceLease({ env }, operation);
      const preserve = (operation: () => unknown) =>
        assertSqliteMigrationScopePreserved(database, scope, operation);
      const migrate = () =>
        config.admission
          ? ensureOpenClawAgentDatabaseSchema(database, { agentId: "main", path: pathname, env })
          : ensureOpenClawAgentSchema(database, "main", pathname, target);
      await run({
        database,
        async migrate(outcome = "commit") {
          if (outcome === "rollback") {
            refuseVersion(database, target);
          }
          try {
            await withLease(async () =>
              preserve(() => {
                if (outcome === "rollback") {
                  expect(migrate).toThrow(/authoriz/u);
                } else {
                  migrate();
                }
              }),
            );
          } finally {
            database.setAuthorizer(null);
          }
        },
        async restore(capture) {
          const before = capture();
          const beforeStatistics = statistics(database);
          const backupPath = `${pathname}.scoped.bak`;
          expect(
            resolveSchemaMigrationBackupTables({
              kind: "agent",
              foundVersion: predecessor,
              supportedVersion: target,
            }),
          ).toEqual(scope);
          await withLease(async (lease) => {
            await createScopedMigrationSnapshot({
              sourcePath: pathname,
              targetPath: backupPath,
              tables: scope,
              beforePublish: () => lease.assertOwned(),
            });
            migrate();
          });
          database.exec("UPDATE cache_entries SET blob = X'BEEF' WHERE scope = 'unrelated'");
          await preserve(() =>
            restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env }),
          );
          expect(capture()).toEqual(before);
          expect(statistics(database)).toEqual(beforeStatistics);
          expect(row(database, "SELECT hex(blob) AS bytes FROM cache_entries")).toEqual({
            bytes: "BEEF",
          });
        },
      });
    });
}
