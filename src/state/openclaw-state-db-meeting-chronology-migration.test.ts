import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { prepareDoctorDatabaseMigrations } from "../commands/doctor-schema-migrations.js";
import {
  createScopedMigrationSnapshot,
  inspectScopedMigrationSnapshot,
} from "../infra/sqlite-migration-scoped-snapshot.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { migrateMeetingTranscriptStartTime } from "./openclaw-state-db-meeting-chronology-migration.js";
import { withLegacyStateHeadLayout } from "./openclaw-state-db-schema-v26-layout.js";
import { withLegacyStateWriteIndexes } from "./openclaw-state-db-schema-v27-indexes.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const retainedStarts = [
  { session_id: "iso", started_at: "2026-01-01T00:00:00Z", started_at_ms: 1767225600000 },
  { session_id: "offset", started_at: "2026-01-01T02:00:00+02:00", started_at_ms: 1767225600000 },
  {
    session_id: "local",
    started_at: "2026-01-01T00:00:00",
    // Worker-thread TZ mutation does not change V8's zone; use the migrating process's calendar.
    started_at_ms: new Date(2026, 0, 1).getTime(),
  },
  { session_id: "garbage", started_at: "not a date", started_at_ms: null },
];
const readStarts = `SELECT session_id, started_at, started_at_ms
  FROM meeting_transcript_sessions ORDER BY session_id`;

describe("meeting transcript chronology migration", () => {
  const directories = useAutoCleanupTempDirTracker((cleanup) => {
    afterAll(async () => {
      await closeOpenClawStateDatabaseAsync();
      cleanup();
    });
  });
  let template: string;

  beforeAll(() => {
    const previousVersion = MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION - 1;
    template = path.join(directories.make("meeting-chronology-template-"), "openclaw.sqlite");
    using db = new DatabaseSync(template);
    db.exec(withLegacyStateWriteIndexes(withLegacyStateHeadLayout(OPENCLAW_STATE_SCHEMA_SQL)));
    db.exec(`DROP INDEX idx_meeting_transcript_sessions_chronology;
      ALTER TABLE meeting_transcript_sessions DROP COLUMN started_at_ms;
      DROP TABLE secret_store_entries;
      PRAGMA user_version = ${previousVersion};
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', ${previousVersion}, 1, 1);
      INSERT INTO acp_replay_sessions
        (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes)
        VALUES ('retained-replay', 'retained-key', '/synthetic', 1, 1, 1, 0, 0);`);
    const insert = db.prepare(`INSERT INTO meeting_transcript_sessions
      (session_id, started_at, selector, export_key, session_slug, provider_id,
       source_json, metadata_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, 'synthetic', '{"accountId":"retained"}', '{"agentId":"main"}', 1, 1)`);
    for (const row of retainedStarts) {
      insert.run(row.session_id, row.started_at, row.session_id, row.session_id, row.session_id);
    }
    db.exec(`INSERT INTO meeting_transcript_utterances
        (session_id, session_started_at, sequence, text)
        VALUES ('iso', '2026-01-01T00:00:00Z', 0, 'Retained utterance');
      INSERT INTO meeting_transcript_summaries
        (session_id, session_started_at, markdown, utterance_count)
        VALUES ('iso', '2026-01-01T00:00:00Z', 'Retained summary', 1);
      INSERT INTO plugin_blob_entries
        (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
        VALUES ('retained-plugin', 'retained', 'bytes', '{"keep":"bytes"}',
          X'00010200FFFE', 9223372036854775807, NULL);
      ANALYZE;`);
    expect(db.prepare("SELECT 1 FROM sqlite_stat1 LIMIT 1").get()).toBeDefined();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
  });

  it("keeps Doctor on a full backup when a later version has no declared scope", async () => {
    const stateDir = directories.make("meeting-chronology-doctor-full-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const pathname = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.copyFileSync(template, pathname);
    using database = new DatabaseSync(pathname);
    database.exec("DROP INDEX idx_acp_replay_sessions_updated;");
    const originalSessions = database
      .prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id")
      .all();
    const schemaQuery = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
    const originalSchema = database.prepare(schemaQuery).all();
    const migration = {
      kind: "state" as const,
      path: pathname,
      foundVersion: MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION - 1,
      supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    };
    expect(resolveSchemaMigrationBackupTables(migration)).toBeUndefined();
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {},
    });
    try {
      await maintenance.run(() =>
        assertSqliteMigrationScopePreserved(database, [], async () => {
          const result = await prepareDoctorDatabaseMigrations({
            env,
            pendingDatabasePaths: [pathname],
            pendingMigrations: [migration],
            databasePaths: [pathname],
            agentDatabaseTargets: [],
          });
          expect(result.warnings).toEqual([]);
          expect(result.versionMigrations).toBeUndefined();
        }),
      );
    } finally {
      await maintenance.close();
    }
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
      migration.foundVersion,
    );
    expect(readStateSchemaContentVersion(database)).toBe(migration.foundVersion);
    expect(
      database.prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id").all(),
    ).toEqual(originalSessions);
    const archives = fs.readdirSync(path.dirname(pathname)).filter((name) => name.endsWith(".bak"));
    expect(archives).toEqual([expect.not.stringMatching(/\.scoped\.bak$/)]);
    using archive = new DatabaseSync(path.join(path.dirname(pathname), archives[0]!), {
      readOnly: true,
    });
    expect(archive.prepare("PRAGMA user_version").get()?.user_version).toBe(migration.foundVersion);
    expect(readStateSchemaContentVersion(archive)).toBe(migration.foundVersion);
    expect(archive.prepare(schemaQuery).all()).toEqual(originalSchema);
    expect(
      archive.prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id").all(),
    ).toEqual(originalSessions);
    expect(
      archive.prepare("SELECT metadata_json, hex(blob) AS bytes FROM plugin_blob_entries").get(),
    ).toEqual({ metadata_json: '{"keep":"bytes"}', bytes: "00010200FFFE" });
  });

  it("restores a historical chronology archive without performing unrelated repairs", async () => {
    const stateDir = directories.make("meeting-chronology-doctor-version-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const pathname = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.copyFileSync(template, pathname);
    using database = new DatabaseSync(pathname);
    // Version migration must leave same-version repair to its later Doctor owner.
    database.exec("DROP INDEX idx_acp_replay_sessions_updated;");
    const originalSessions = database
      .prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id")
      .all();
    const migration = {
      kind: "state" as const,
      path: pathname,
      foundVersion: MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION - 1,
      supportedVersion: MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION,
    };
    const tables = ["config_machine_state", "meeting_transcript_sessions", "schema_meta"];
    expect(resolveSchemaMigrationBackupTables(migration)).toEqual(tables);
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {},
    });
    try {
      await maintenance.run(() =>
        assertSqliteMigrationScopePreserved(database, tables, async () => {
          await createScopedMigrationSnapshot({
            sourcePath: pathname,
            targetPath: `${pathname}.chronology-v23.scoped.bak`,
            tables,
            beforePublish: () => maintenance.assertAdmission(),
          });
          // Reconstruct the historical v23 result; current-chain migration is covered below.
          runSqliteImmediateTransactionSync(database, () => {
            expect(migrateMeetingTranscriptStartTime(database, migration.foundVersion)).toBe(true);
            database.exec(`
              CREATE INDEX idx_meeting_transcript_sessions_chronology
                ON meeting_transcript_sessions(started_at_ms DESC, session_id ASC, started_at ASC);
              UPDATE schema_meta SET schema_version = ${migration.supportedVersion}
                WHERE meta_key = 'primary';
              INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
                VALUES ('state.schema.contentVersion', '${migration.supportedVersion}', 1);
              PRAGMA user_version = ${migration.supportedVersion};
            `);
          });
        }),
      );
    } finally {
      await maintenance.close();
    }
    expect(database.prepare(readStarts).all()).toEqual(
      retainedStarts.toSorted((left, right) => left.session_id.localeCompare(right.session_id)),
    );
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
      migration.supportedVersion,
    );
    expect(readStateSchemaContentVersion(database)).toBe(migration.supportedVersion);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'idx_acp_replay_sessions_updated'")
        .get(),
    ).toBeUndefined();
    const archives = fs.readdirSync(path.dirname(pathname)).filter((name) => name.endsWith(".bak"));
    expect(archives).toEqual([expect.stringMatching(/\.scoped\.bak$/)]);
    const backupPath = path.join(path.dirname(pathname), archives[0]!);
    expect(inspectScopedMigrationSnapshot(backupPath).tables.map((table) => table.name)).toEqual(
      tables,
    );

    database.exec(`UPDATE plugin_blob_entries SET metadata_json = '{"keep":"later owner write"}'
      WHERE plugin_id = 'retained-plugin'`);
    await assertSqliteMigrationScopePreserved(database, tables, () =>
      restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env }),
    );
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
      migration.foundVersion,
    );
    expect(
      database.prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id").all(),
    ).toEqual(originalSessions);
    expect(
      database.prepare("SELECT metadata_json FROM plugin_blob_entries").get()?.metadata_json,
    ).toBe('{"keep":"later owner write"}');
  });

  it.each(["runtime", "doctor"] as const)(
    "backfills once through %s and preserves undeclared table bytes, schema, and statistics",
    async (owner) => {
      const stateDir = directories.make(`meeting-chronology-${owner}-`);
      const pathname = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
      fs.copyFileSync(template, pathname);
      const options = { env: { OPENCLAW_STATE_DIR: stateDir }, path: pathname };
      using scope = new DatabaseSync(pathname, { readOnly: true });
      const originalSessions = scope
        .prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id")
        .all();
      const backupTables = ["config_machine_state", "meeting_transcript_sessions", "schema_meta"];
      expect(
        resolveSchemaMigrationBackupTables({
          kind: "state",
          foundVersion: MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION - 1,
          supportedVersion: MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION,
        }),
      ).toEqual(backupTables);
      const migrationTables = [
        ...backupTables,
        "acp_replay_events",
        "session_state_heads",
        "skill_usage",
        "state_leases",
        "sqlite_stat1",
        "sqlite_stat4",
      ];
      const { db } = await assertSqliteMigrationScopePreserved(scope, migrationTables, () => {
        if (owner === "doctor") {
          expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
        }
        return openOpenClawStateDatabase(options);
      });
      const expected = retainedStarts.toSorted((left, right) =>
        left.session_id.localeCompare(right.session_id),
      );
      expect(db.prepare(readStarts).all()).toEqual(expected);
      expect(
        db
          .prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id")
          .all()
          .map(({ started_at_ms: _startedAtMs, ...row }) => row),
      ).toEqual(originalSessions);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      expect(readStateSchemaContentVersion(db)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);

      await closeOpenClawStateDatabaseAsync();
      const reopened = openOpenClawStateDatabase(options);
      expect(reopened.db.prepare(readStarts).all()).toEqual(expected);
    },
  );
});
