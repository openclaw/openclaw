import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { archiveSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { backupDoctorMigrationDatabases } from "../commands/doctor-migration-backup.js";
import { stateTemplateNamesMigration } from "./openclaw-state-db-schema-v36-template-names.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { inspectStateDatabaseSchema } from "./openclaw-state-schema-preflight.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const schema35 = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-state-schema-v35.sql", import.meta.url),
  "utf8",
);
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const scope = ["schema_meta", "config_machine_state", "subagent_run_archives"];
const payload = ` ${JSON.stringify(
  createSubagentRunRecord({
    runId: "old-keep",
    createdAt: 1,
    endedAt: 2,
    cleanupCompletedAt: 3,
    expectsCompletionMessage: false,
  }),
)} `;
function fixture(refuse = false) {
  const env = { OPENCLAW_STATE_DIR: dirs.make("subagent-archive-migration-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  // Frozen schema 35 plus its released successor migration, independent of v37 DDL.
  db.exec(schema35);
  stateTemplateNamesMigration.migrate(db, 35);
  db.exec(`PRAGMA user_version = 36;
    INSERT INTO schema_meta VALUES ('primary', 'global', 36, NULL, 'pre-archive', 1, 1);
    INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '36', 1);
    CREATE TABLE fixture_unrelated (value BLOB) STRICT;
    INSERT INTO fixture_unrelated VALUES (X'0001FF');`);
  db.prepare(`INSERT INTO subagent_runs
    (run_id, child_session_key, requester_session_key, created_at, payload_json)
    VALUES ('old-keep', 'agent:main:subagent:child', 'agent:main:main', 1, ?)`).run(payload);
  if (refuse) {
    db.exec(`CREATE TRIGGER refuse_archive_version BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'archive version refused'); END;`);
  }
  return { env, path: pathname };
}

it.each(["startup", "doctor"] as const)(
  "creates an empty archive through %s and recovers hot history after later archival",
  async (owner) => {
    const options = fixture();
    using witness = new DatabaseSync(options.path);
    await withStateMigrationBackupForTest(options, async () => {
      const backup = await backupDoctorMigrationDatabases({
        env: options.env,
        databasePaths: [options.path],
        pendingDatabasePaths: [options.path],
        pendingMigrations: [
          { kind: "state", path: options.path, foundVersion: 36, supportedVersion: 37 },
        ],
        versionMigrationsOnly: true,
      });
      expect(backup.warnings).toEqual([]);
      return assertSqliteMigrationScopePreserved(witness, scope, () => {
        if (owner === "doctor") {
          expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
        } else {
          openOpenClawStateDatabase(options);
        }
      });
    });
    expect(witness.prepare("PRAGMA user_version").get()).toEqual({ user_version: 37 });
    expect(
      inspectStateDatabaseSchema(witness, {
        pathname: options.path,
        supportedVersion: 36,
        scope: "state",
        purpose: "runtime",
      }).schemas.incompatible,
    ).toMatchObject([{ foundVersion: 37, supportedVersion: 36 }]);
    expect(witness.prepare("SELECT * FROM subagent_run_archives").all()).toEqual([]);
    expect(
      witness
        .prepare(
          "SELECT name FROM pragma_index_list('subagent_run_archives') WHERE origin = 'c' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "idx_subagent_run_archives_child_session_key" },
      { name: "idx_subagent_run_archives_controller_session_key" },
      { name: "idx_subagent_run_archives_requester_session_key" },
    ]);
    await withStateMigrationBackupForTest(options, () =>
      expect(
        runOpenClawStateWriteTransaction(
          (database) => archiveSubagentRunValuesInDatabase(database, ["old-keep"], 31 * 86_400_000),
          options,
        ),
      ).toEqual(["old-keep"]),
    );
    expect(witness.prepare("SELECT * FROM subagent_runs").all()).toEqual([]);
    expect(witness.prepare("SELECT payload_json FROM subagent_run_archives").get()).toEqual({
      payload_json: payload,
    });
    await closeOpenClawStateDatabaseAsync();
    const backups = readdirSync(path.dirname(options.path)).filter((name) =>
      name.endsWith(".scoped.bak"),
    );
    expect(backups).toHaveLength(1);
    await restoreDoctorMigrationBackup({
      sourcePath: options.path,
      backupPath: path.join(path.dirname(options.path), backups[0]!),
      env: options.env,
    });
    expect(witness.prepare("PRAGMA user_version").get()).toEqual({ user_version: 36 });
    expect(
      witness.prepare("SELECT name FROM sqlite_schema WHERE name = 'subagent_run_archives'").all(),
    ).toEqual([]);
    expect(witness.prepare("SELECT payload_json FROM subagent_runs").get()).toEqual({
      payload_json: payload,
    });
  },
);

it("rolls back archive creation with refused version publication", async () => {
  const options = fixture(true);
  await expect(
    withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
  ).rejects.toThrow("archive version refused");
  using db = new DatabaseSync(options.path);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 36 });
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name = 'subagent_run_archives'").all(),
  ).toEqual([]);
  expect(db.prepare("SELECT payload_json FROM subagent_runs").get()).toEqual({
    payload_json: payload,
  });
});
