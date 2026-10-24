import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { withLegacyLocalWorkspaceManifests } from "./openclaw-state-db-schema-v31-workspace-manifests.js";
import {
  closeOpenClawStateDatabaseAsync,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

function predecessor(absent = false, refuse = false) {
  const env = { OPENCLAW_STATE_DIR: directories.make("workspace-manifest-migration-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using database = new DatabaseSync(pathname);
  database.exec(withLegacyLocalWorkspaceManifests(OPENCLAW_STATE_SCHEMA_SQL));
  database.exec(`PRAGMA user_version = 30;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', 30, 1, 1);`);
  const baseline = '{"version":1,"baseCommit":null,"directories":[],"entries":[]}\n';
  const baselineRef = `sha256:${createHash("sha256").update(baseline).digest("hex")}`;
  database
    .prepare(`INSERT INTO local_workspace_projections
    (worktree_id, agent_id, session_key, session_id, projection_path, base_commit,
      source_paths_json, baseline_json, baseline_ref, pending_ref, pending_target,
      paused_runtimes_json, journal_json, journal_pack, revision, created_at_ms)
    VALUES ('workspace', 'main', 'agent:main:workspace', 'session', '/synthetic/projection',
      'base', '["source.txt"]', ?, ?, 'refs/openclaw/results/pending', 'canonical',
      '["paused-runtime"]', '{"pending":"rollback"}', ?, 7, 1)`)
    .run(baseline, baselineRef, new Uint8Array([0, 17, 255]));
  const before = database.prepare("SELECT rowid, * FROM local_workspace_projections").get();
  if (absent) {
    database.exec("DROP TABLE local_workspace_projections;");
  }
  if (refuse) {
    database.exec(`CREATE TRIGGER refuse_workspace_schema_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'workspace schema publication interrupted'); END;`);
  }
  return { options: { env, path: pathname }, pathname, before };
}

it.each([false, true])(
  "upgrades workspace storage while preserving pending recovery bytes (unused: %s)",
  async (absent) => {
    const { options, pathname, before } = predecessor(absent);
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "local-workspace-manifests-v31", path: pathname },
    ]);
    await withStateMigrationBackupForTest(options, async () => {
      using witness = new DatabaseSync(pathname);
      const database = await assertSqliteMigrationScopePreserved(
        witness,
        [
          "schema_meta",
          "config_machine_state",
          "local_workspace_projections",
          "local_workspace_manifest_nodes",
          "sqlite_stat1",
          "sqlite_stat4",
        ],
        () => openOpenClawStateDatabase(options),
      );
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        database.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name LIKE 'local_workspace_%' ORDER BY name",
          )
          .all(),
      ).toEqual(
        absent
          ? []
          : [{ name: "local_workspace_manifest_nodes" }, { name: "local_workspace_projections" }],
      );
      if (!absent) {
        expect(
          database.db.prepare("SELECT rowid, * FROM local_workspace_projections").get(),
        ).toEqual({
          ...before,
          checkpoint_json: null,
        });
        expect(database.db.prepare("SELECT * FROM local_workspace_manifest_nodes").all()).toEqual(
          [],
        );
        // Converted baselines may retain their root without the old full document.
        database.db.exec(`SAVEPOINT converted_baseline;
          UPDATE local_workspace_projections SET baseline_json = NULL;
          ROLLBACK TO converted_baseline;
          RELEASE converted_baseline;`);
      }
      await closeOpenClawStateDatabaseAsync();
      const reopened = openOpenClawStateDatabase(options);
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
      if (!absent) {
        expect(
          reopened.db.prepare("SELECT rowid, * FROM local_workspace_projections").get(),
        ).toEqual({
          ...before,
          checkpoint_json: null,
        });
      }
    });
  },
);

it("rolls back interrupted workspace schema acceptance and retries with the original receipt", async () => {
  const { options, pathname, before } = predecessor(false, true);
  await expect(
    withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
  ).rejects.toThrow("workspace schema publication interrupted");
  await closeOpenClawStateDatabaseAsync();
  {
    using database = new DatabaseSync(pathname);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 30 });
    expect(database.prepare("SELECT rowid, * FROM local_workspace_projections").get()).toEqual(
      before,
    );
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'local_workspace_manifest_nodes'")
        .get(),
    ).toBeUndefined();
    database.exec("DROP TRIGGER refuse_workspace_schema_publication;");
  }
  await withStateMigrationBackupForTest(options, () => {
    const database = openOpenClawStateDatabase(options);
    expect(database.db.prepare("SELECT rowid, * FROM local_workspace_projections").get()).toEqual({
      ...before,
      checkpoint_json: null,
    });
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });
});
