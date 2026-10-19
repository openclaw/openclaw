import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { prepareDoctorDatabaseMigrations as prepareMigrations } from "../commands/doctor-schema-migrations.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  createScopedMigrationSnapshot,
  inspectScopedMigrationSnapshot,
} from "../infra/sqlite-migration-scoped-snapshot.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { createOpenClawDatabaseMaintenanceScope as createMaintenance } from "./openclaw-state-db-async-lifecycle.js";
import {
  MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION as CHRONOLOGY_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import {
  expectRow,
  expectRows,
  readRow,
  readRows,
} from "./openclaw-state-db-fixtures.test-support.js";
import { migrateMeetingTranscriptStartTime } from "./openclaw-state-db-meeting-chronology-migration.js";
import { withLegacyStateHeadLayout } from "./openclaw-state-db-schema-v26-layout.js";
import { withLegacyStateWriteIndexes } from "./openclaw-state-db-schema-v27-indexes.js";
import { readStateSchemaContentVersion as readVersion } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseAsync as closeStateAsync,
  openOpenClawStateDatabase as openState,
  repairOpenClawStateDatabaseSchema as repairSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL as SCHEMA_SQL } from "./openclaw-state-schema.js";
import { resolveSchemaMigrationBackupTables as backupScope } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved as preserveScope } from "./sqlite-migration-scope.test-support.js";

// Local-date migration uses the process calendar; worker TZ mutations do not change V8's zone.
const retainedStarts = [
  ["iso", "2026-01-01T00:00:00Z", 1767225600000],
  ["offset", "2026-01-01T02:00:00+02:00", 1767225600000],
  ["local", "2026-01-01T00:00:00", new Date(2026, 0, 1).getTime()],
  ["garbage", "not a date", null],
] as const;
const readStarts = `SELECT session_id, started_at, started_at_ms
  FROM meeting_transcript_sessions ORDER BY session_id`;
const readSessions = "SELECT * FROM meeting_transcript_sessions ORDER BY session_id";
const expectedStarts = retainedStarts
  .map(([session_id, started_at, started_at_ms]) => ({ session_id, started_at, started_at_ms }))
  .toSorted((a, b) => a.session_id.localeCompare(b.session_id));
const backupTables = ["config_machine_state", "meeting_transcript_sessions", "schema_meta"];
const chronologyMigration = {
  kind: "state" as const,
  foundVersion: CHRONOLOGY_VERSION - 1,
  supportedVersion: CHRONOLOGY_VERSION,
};

function expectVersion(db: EngineConnection, version: number) {
  expect(readRow(db, "PRAGMA user_version")?.user_version).toBe(version);
  expect(readVersion(db)).toBe(version);
}

async function withMaintenance(
  run: (scope: ReturnType<typeof createMaintenance>) => Promise<unknown>,
) {
  const scope = createMaintenance({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
  });
  try {
    await scope.run(() => run(scope));
  } finally {
    await scope.close();
  }
}

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeStateAsync();
    cleanup();
  });
});
let template: string;

function fixture(label: string) {
  const env = { OPENCLAW_STATE_DIR: directories.make(`meeting-chronology-${label}-`) };
  const pathname = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.copyFileSync(template, pathname);
  return { env, pathname };
}

beforeAll(() => {
  const previousVersion = CHRONOLOGY_VERSION - 1;
  template = path.join(directories.make("meeting-chronology-template-"), "openclaw.sqlite");
  using db = new DatabaseSync(template);
  db.exec(withLegacyStateWriteIndexes(withLegacyStateHeadLayout(SCHEMA_SQL)));
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
  for (const [id, startedAt] of retainedStarts) {
    insert.run(id, startedAt, id, id, id);
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
  expect(readRow(db, "SELECT 1 FROM sqlite_stat1 LIMIT 1")).toBeDefined();
});

afterEach(closeStateAsync);

it("keeps Doctor on a full backup when a later version has no declared scope", async () => {
  const { env, pathname } = fixture("doctor-full");
  using db = new DatabaseSync(pathname);
  db.exec("DROP INDEX idx_acp_replay_sessions_updated;");
  const originalSessions = readRows(db, readSessions);
  const schemaQuery = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
  const originalSchema = readRows(db, schemaQuery);
  const migration = { ...chronologyMigration, path: pathname, supportedVersion: SCHEMA_VERSION };
  expect(backupScope(migration)).toBeUndefined();
  await withMaintenance(() =>
    preserveScope(db, [], async () => {
      const result = await prepareMigrations({
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
  expectVersion(db, migration.foundVersion);
  expectRows(db, readSessions, originalSessions);
  const archives = fs.readdirSync(path.dirname(pathname)).filter((name) => name.endsWith(".bak"));
  expect(archives).toEqual([expect.not.stringMatching(/\.scoped\.bak$/)]);
  using archive = new DatabaseSync(path.join(path.dirname(pathname), archives[0]!), {
    readOnly: true,
  });
  expectVersion(archive, migration.foundVersion);
  expectRows(archive, schemaQuery, originalSchema);
  expectRows(archive, readSessions, originalSessions);
  expectRow(archive, "SELECT metadata_json, hex(blob) AS bytes FROM plugin_blob_entries", {
    metadata_json: '{"keep":"bytes"}',
    bytes: "00010200FFFE",
  });
});

it("restores a historical chronology archive without performing unrelated repairs", async () => {
  const { env, pathname } = fixture("doctor-version");
  using db = new DatabaseSync(pathname);
  // Version migration must leave same-version repair to its later Doctor owner.
  db.exec("DROP INDEX idx_acp_replay_sessions_updated;");
  const originalSessions = readRows(db, readSessions);
  const migration = { ...chronologyMigration, path: pathname };
  const tables = backupTables;
  expect(backupScope(migration)).toEqual(tables);
  await withMaintenance((maintenance) =>
    preserveScope(db, tables, async () => {
      await createScopedMigrationSnapshot({
        sourcePath: pathname,
        targetPath: `${pathname}.chronology-v23.scoped.bak`,
        tables,
        beforePublish: () => maintenance.assertAdmission(),
      });
      // Reconstruct the historical v23 result; current-chain migration is covered below.
      runSqliteImmediateTransactionSync(db, () => {
        expect(migrateMeetingTranscriptStartTime(db, migration.foundVersion)).toBe(true);
        db.exec(`
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
  expectRows(db, readStarts, expectedStarts);
  expectVersion(db, migration.supportedVersion);
  expect(
    readRow(db, "SELECT 1 FROM sqlite_schema WHERE name = 'idx_acp_replay_sessions_updated'"),
  ).toBeUndefined();
  const archives = fs.readdirSync(path.dirname(pathname)).filter((name) => name.endsWith(".bak"));
  expect(archives).toEqual([expect.stringMatching(/\.scoped\.bak$/)]);
  const backupPath = path.join(path.dirname(pathname), archives[0]!);
  expect(inspectScopedMigrationSnapshot(backupPath).tables.map((table) => table.name)).toEqual(
    tables,
  );

  db.exec(`UPDATE plugin_blob_entries SET metadata_json = '{"keep":"later owner write"}'
      WHERE plugin_id = 'retained-plugin'`);
  await preserveScope(db, tables, () =>
    restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env }),
  );
  expect(readRow(db, "PRAGMA user_version")?.user_version).toBe(migration.foundVersion);
  expectRows(db, readSessions, originalSessions);
  expect(readRow(db, "SELECT metadata_json FROM plugin_blob_entries")?.metadata_json).toBe(
    '{"keep":"later owner write"}',
  );
});

it.each(["runtime", "doctor"] as const)(
  "backfills once through %s and preserves undeclared table bytes, schema, and statistics",
  async (owner) => {
    const { env, pathname } = fixture(owner);
    const options = { env, path: pathname };
    using scope = new DatabaseSync(pathname, { readOnly: true });
    const originalSessions = readRows(scope, readSessions);
    expect(backupScope(chronologyMigration)).toEqual(backupTables);
    const migrationTables = [
      ...backupTables,
      "acp_replay_events",
      "session_state_heads",
      "skill_usage",
      "state_leases",
      "sqlite_stat1",
      "sqlite_stat4",
    ];
    const { db } = await preserveScope(scope, migrationTables, () => {
      if (owner === "doctor") {
        expect(repairSchema(options).warnings).toEqual([]);
      }
      return openState(options);
    });
    expectRows(db, readStarts, expectedStarts);
    expect(
      readRows(db, readSessions).map(({ started_at_ms: _startedAtMs, ...row }) => row),
    ).toEqual(originalSessions);
    expectVersion(db, SCHEMA_VERSION);
    expectRow(db, "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'", {
      schema_version: SCHEMA_VERSION,
    });

    await closeStateAsync();
    const reopened = openState(options);
    expectRows(reopened.db, readStarts, expectedStarts);
  },
);
