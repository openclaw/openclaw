import { deepStrictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { execSql, openRawDatabase } from "./database-preflight-fixtures.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawStateDatabasePath,
} from "./openclaw-database-preflight.js";
import {
  snapshotSourceFamily,
  writeUnreadableNewerStateSchema,
} from "./openclaw-database-preflight.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  expectRow,
  expectRows,
  readRow,
  readRows,
} from "./openclaw-state-db-fixtures.test-support.js";
import { withLegacyLocalWorkspaceManifests } from "./openclaw-state-db-schema-v31-workspace-manifests.js";
import { withLegacyLocalWorkspaceCas } from "./openclaw-state-db-schema-v35-workspace-cas.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL } from "./openclaw-state-schema-v13-widerow.test-support.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const templateDirs = useAutoCleanupTempDirTracker(afterAll);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
let templatePath: string;

beforeAll(async () => {
  const stateDir = templateDirs.make("openclaw-plugin-index-template-");
  templatePath = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }).path;
  await closeOpenClawStateDatabaseAsync();
  using legacy = openRawDatabase(templatePath);
  restorePreTemplateStateIdentifiersForTest(legacy);
  addPreCutoverClientCredentialTablesForTest(legacy);
  legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
});

const validIndex = {
  install_records_json: '{ "demo": { "source": "npm", "spec": "demo@1.0.0" } }',
  plugins_json: "[]",
  diagnostics_json: "[]",
};

function createLegacyStateDatabase(values: typeof validIndex) {
  const stateDir = tempDirs.make("openclaw-plugin-index-migration-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = resolveOpenClawStateSqlitePath(options.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(templatePath, databasePath);
  const legacy = openRawDatabase(databasePath);
  legacy
    .prepare(`INSERT INTO installed_plugin_index (
    index_key, version, host_contract_version, compat_registry_version, migration_version,
    policy_hash, generated_at_ms, install_records_json, plugins_json, diagnostics_json, updated_at_ms
  ) VALUES ('installed-plugin-index', 1, 'host', 'compat', 1, 'policy', 10, ?, ?, ?, 11)`)
    .run(values.install_records_json, values.plugins_json, values.diagnostics_json);
  const original = readRow(legacy, "SELECT * FROM installed_plugin_index");
  return { legacy, options, original };
}

it.each(
  (["runtime open", "doctor repair"] as const).flatMap((migrationPath) => [
    [migrationPath, "install_records_json", "[]"] as const,
    [migrationPath, "install_records_json", "{"] as const,
    [migrationPath, "plugins_json", "{}"] as const,
    [migrationPath, "diagnostics_json", "{"] as const,
  ]),
)(
  "preserves an invalid plugin-index row during captured v13 %s when %s is invalid (%s)",
  async (migrationPath, column, value) => {
    const values = { ...validIndex, [column]: value };
    const { legacy, options, original } = createLegacyStateDatabase(values);
    legacy.close();

    await withStateMigrationBackupForTest(options, () => {
      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      openOpenClawStateDatabase(options);
    });
    const { db } = openOpenClawStateDatabase(options);
    expect(
      readRow(db, "SELECT name FROM sqlite_schema WHERE name = 'installed_plugin_index'"),
    ).toBeUndefined();
    const quarantine =
      "SELECT payload_json FROM diagnostic_events WHERE scope = 'plugins.installedIndex.quarantine'";
    const preserved = readRow(db, quarantine);
    expect(preserved).toBeDefined();
    expect(JSON.parse(String(preserved?.payload_json))).toMatchObject({
      level: "warn",
      message: expect.stringContaining("openclaw doctor --fix"),
      raw: original,
    });
    const folded = readConfigMachineState<{ index: { installRecords: unknown } }>(
      "plugins.installedIndex",
      options,
    );
    expect(folded?.index.installRecords).toEqual(
      column === "install_records_json" ? null : JSON.parse(values.install_records_json),
    );
    expectRow(db, "PRAGMA integrity_check", { integrity_check: "ok" });
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expectVersion(reopened);
    expectRows(reopened, quarantine, [preserved]);
  },
);

it("keeps the legacy plugin-index row when quarantine preservation fails", async () => {
  const { legacy, options, original } = createLegacyStateDatabase({
    ...validIndex,
    install_records_json: "{",
  });
  legacy.exec(`
      INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at, sequence)
      VALUES ('plugins.installedIndex.quarantine', 'retained', '{}', 1, 9007199254740991);
    `);
  legacy.close();

  await expect(
    withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
  ).rejects.toThrow("Audit sequence exhausted");
  using retained = openRawDatabase(resolveOpenClawStateSqlitePath(options.env));
  expectRow(retained, "SELECT * FROM installed_plugin_index", original);
  expectVersion(retained, 12);
  expect(
    readRow(
      retained,
      "SELECT value_json FROM config_machine_state WHERE state_key = ?",
      "plugins.installedIndex",
    ),
  ).toBeUndefined();
});

it("repairs fractional trace timestamps while captured doctor migration advances version 2 to STRICT", async () => {
  const stateDir = tempDirs.make("openclaw-state-restart-handoff-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();

  const legacy = openRawDatabase(databasePath);
  restorePreTemplateStateIdentifiersForTest(legacy);
  addPreCutoverClientCredentialTablesForTest(legacy);
  const strictCreateSql = (
    legacy
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'gateway_restart_handoff'",
      )
      .get() as { sql: string }
  ).sql;
  const flexibleCreateSql = strictCreateSql.replace(/\s+STRICT$/u, "");
  expect(flexibleCreateSql).not.toBe(strictCreateSql);
  // The synthetic pre-STRICT database predates this placement index.
  legacy.exec("DROP INDEX idx_worker_session_placements_environment;");
  legacy.exec(`
      DROP INDEX idx_gateway_restart_handoff_expiry;
      ALTER TABLE gateway_restart_handoff RENAME TO gateway_restart_handoff_strict;
      ${flexibleCreateSql};
      DROP TABLE gateway_restart_handoff_strict;
      PRAGMA user_version = 2;
      UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
    `);
  const now = Date.now();
  const insert = legacy.prepare(`
      INSERT INTO gateway_restart_handoff (handoff_key, kind, version, intent_id, pid,
        process_instance_id, created_at, expires_at, reason, restart_trace_started_at,
        restart_trace_last_at, source, restart_kind, supervisor_mode, updated_at_ms)
      VALUES (?, 'gateway-supervisor-restart-handoff', 1, ?, 4242, ?, ?, ?,
                'update.run', ?, ?, 'gateway-update', 'update-process', 'systemd', ?)
    `);
  for (const [key, created, expires, started, last] of [
    ["expired", -120_000, -60_000, -130_000, -129_000],
    ["current", -1_000, 59_000, -5_000, -1_000],
  ] as const) {
    insert.run(
      key,
      `${key}-intent`,
      `${key}-process`,
      now + created,
      now + expires,
      now + started + 0.9,
      now + last + 0.4,
      now,
    );
  }
  legacy.close();

  expect(
    await withStateMigrationBackupForTest(options, () =>
      repairOpenClawStateDatabaseSchema(options),
    ),
  ).toMatchObject({
    changes: expect.arrayContaining(["Migrated shared state tables to SQLite STRICT typing (1)"]),
    warnings: [],
  });

  const { db } = openOpenClawStateDatabase(options);
  expectVersion(db);
  expectRow(db, "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'", {
    schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expectRow(db, "SELECT strict FROM pragma_table_list WHERE name = 'gateway_restart_handoff'", {
    strict: 1,
  });
  expectRows(
    db,
    `SELECT handoff_key, typeof(restart_trace_started_at) AS started_type,
             restart_trace_started_at, typeof(restart_trace_last_at) AS last_type,
             restart_trace_last_at
           FROM gateway_restart_handoff
           ORDER BY handoff_key`,
    [
      {
        handoff_key: "current",
        started_type: "integer",
        restart_trace_started_at: Math.floor(now - 5_000 + 0.9),
        last_type: "integer",
        restart_trace_last_at: Math.floor(now - 1_000 + 0.4),
      },
    ],
  );
});

function predecessor(absent = false, refuse = false) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("workspace-manifest-migration-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  using database = openRawDatabase(pathname);
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
  const before = projection(database);
  if (absent) {
    database.exec("DROP TABLE local_workspace_projections;");
  }
  if (refuse) {
    database.exec(`CREATE TRIGGER refuse_workspace_schema_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'workspace schema publication interrupted'); END;`);
  }
  return { options: { env, path: pathname }, pathname, before };
}

function projection(database: EngineConnection) {
  return readRow(database, "SELECT rowid, * FROM local_workspace_projections");
}

function expectVersion(database: EngineConnection, version = OPENCLAW_STATE_SCHEMA_VERSION) {
  expectRow(database, "PRAGMA user_version", { user_version: version });
}

it.each([false, true])(
  "upgrades workspace storage while preserving pending recovery bytes (unused: %s)",
  async (absent) => {
    const { options, pathname, before } = predecessor(absent);
    const migratedProjection = {
      ...before,
      checkpoint_json: null,
      tree_root_digest: null,
      source_paths_digest: null,
      canonical_fingerprints: null,
      projection_fingerprints: null,
    };
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "local-workspace-manifests-v31", path: pathname },
      { kind: "local-workspace-cas-v35", path: pathname },
      { kind: "template-names-v36", path: pathname },
      { kind: "worker-resource-receipts-v37", path: pathname },
      { kind: "repository-disk-authority-v38", path: pathname },
    ]);
    await withStateMigrationBackupForTest(options, async () => {
      using witness = openRawDatabase(pathname);
      const database = await assertSqliteMigrationScopePreserved(
        witness,
        [
          "schema_meta",
          "config_machine_state",
          "local_workspace_projections",
          "local_workspace_manifest_nodes",
          "local_workspace_tree_packs",
          "local_workspace_source_path_sets",
          "sqlite_stat1",
          "sqlite_stat4",
        ],
        () => openOpenClawStateDatabase(options),
      );
      expectVersion(database.db);
      expect(
        readRows(
          database.db,
          "SELECT name FROM sqlite_schema WHERE name LIKE 'local_workspace_%' ORDER BY name",
        ),
      ).toEqual(
        absent
          ? []
          : [
              { name: "local_workspace_manifest_nodes" },
              { name: "local_workspace_projections" },
              { name: "local_workspace_source_path_sets" },
              { name: "local_workspace_tree_packs" },
            ],
      );
      if (!absent) {
        expect(projection(database.db)).toEqual(migratedProjection);
        expectRows(database.db, "SELECT * FROM local_workspace_manifest_nodes", []);
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
        expect(projection(reopened.db)).toEqual(migratedProjection);
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
    using database = openRawDatabase(pathname);
    expectVersion(database, 30);
    expect(projection(database)).toEqual(before);
    expect(
      readRow(
        database,
        "SELECT name FROM sqlite_schema WHERE name = 'local_workspace_manifest_nodes'",
      ),
    ).toBeUndefined();
    database.exec("DROP TRIGGER refuse_workspace_schema_publication;");
  }
  await withStateMigrationBackupForTest(options, () => {
    const database = openOpenClawStateDatabase(options);
    expect(projection(database.db)).toEqual({
      ...before,
      checkpoint_json: null,
      tree_root_digest: null,
      source_paths_digest: null,
      canonical_fingerprints: null,
      projection_fingerprints: null,
    });
    expectVersion(database.db);
  });
});

function createStateDatabase(filename = "candidate.sqlite") {
  const stateDir = tempDirs.make("openclaw-explicit-state-preflight-");
  const databasePath = path.join(stateDir, filename);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  using database = openRawDatabase(databasePath);
  // Match production bootstrap: one durable commit, not one per schema object.
  runSqliteImmediateTransactionSync(database, () => {
    database.exec(
      `${OPENCLAW_STATE_SCHEMA_SQL};
         PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
         INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);`,
    );
  });
  return { stateDir, databasePath };
}

function expectNewerSchema(message: string) {
  expect(message).toMatch(/newer/);
  expect(message).toMatch(/build.*supports/);
  expect(message).toMatch(/restore.*backup/);
  expect(message).not.toMatch(/registry query failed|integrity_check failed/);
}

it.each([
  [
    "retired cron history",
    `CREATE TABLE cron_run_logs (entry_json TEXT); INSERT INTO cron_run_logs VALUES ('{"retained":true}');`,
    {
      status: "indeterminate",
      reason: expect.stringMatching(/legacy-cron-run-logs.*doctor --fix/),
    },
  ],
  [
    "drifted canonical index",
    "DROP INDEX idx_task_runs_runtime_run; CREATE INDEX idx_task_runs_runtime_run ON task_runs(task_id);",
    {
      status: "startup-repairable",
      requiresWrite: true,
      issues: [
        {
          code: "missing-or-drifted-index",
          objectName: "idx_task_runs_runtime_run",
        },
      ],
    },
  ],
  [
    "negative schema metadata",
    "PRAGMA user_version = -1;",
    {
      foundVersion: -1,
      status: "indeterminate",
      reason: expect.stringContaining("invalid schema version metadata"),
    },
  ],
  [
    "unreadable newer catalog",
    writeUnreadableNewerStateSchema,
    {
      foundVersion: OPENCLAW_STATE_SCHEMA_VERSION + 1,
      status: "incompatible",
      reason: expect.any(String),
    },
  ],
] as const)("classifies %s without changing the source", async (_name, sql, expected) => {
  const { databasePath } = createStateDatabase();
  if (typeof sql === "string") {
    execSql(databasePath, sql);
  } else {
    sql(databasePath);
  }
  const before = snapshotSourceFamily(databasePath);
  const result = await preflightOpenClawStateDatabasePath(databasePath);
  expect(result).toMatchObject({
    foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    issues: [],
    requiresWrite: false,
    ...expected,
  });
  if (typeof sql === "function") {
    expectNewerSchema(result.reason ?? "");
  }
  deepStrictEqual(snapshotSourceFamily(databasePath), before);
});

it("rejects genuine drift alongside legacy additive columns without writes", async () => {
  const { stateDir, databasePath } = createStateDatabase("state/openclaw.sqlite");
  execSql(
    databasePath,
    "ALTER TABLE task_runs DROP COLUMN tool_use_count; ALTER TABLE task_runs DROP COLUMN last_tool_name; ALTER TABLE apns_registrations DROP COLUMN relay_origin; ALTER TABLE task_runs ADD COLUMN unrecognized INTEGER NOT NULL DEFAULT 0;",
  );
  const before = snapshotSourceFamily(databasePath);
  expect(await preflightOpenClawStateDatabasePath(databasePath)).toMatchObject({
    foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    status: "incompatible",
  });
  const admission = assertOpenClawDatabasesReady({
    env: { OPENCLAW_STATE_DIR: stateDir },
    operation: "gateway-startup",
    config: {},
  });
  await expect(admission).rejects.toThrow("requires repair");
  deepStrictEqual(snapshotSourceFamily(databasePath), before);
});

it.each(["gateway-startup", "gateway-restart"] as const)(
  "reports only the newer schema for an unreadable catalog at %s",
  async (operation) => {
    const { stateDir, databasePath } = createStateDatabase("state/openclaw.sqlite");
    writeUnreadableNewerStateSchema(databasePath);
    const before = snapshotSourceFamily(databasePath);
    const failure = await assertOpenClawDatabasesReady({
      env: { OPENCLAW_STATE_DIR: stateDir },
      operation,
      config: {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expectNewerSchema(String(failure));
    deepStrictEqual(snapshotSourceFamily(databasePath), before);
  },
);

it("rejects an explicit preflight path with sidecars without touching it", async () => {
  const { databasePath } = createStateDatabase();
  using writer = openRawDatabase(databasePath);
  writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('preflight.live', '{}', 1)`);
  const before = snapshotSourceFamily(databasePath);

  await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
    foundVersion: null,
    status: "indeterminate",
    requiresWrite: false,
    reason: expect.stringMatching(/consolidated snapshot.*sidecars.*online backup/iu),
  });
  deepStrictEqual(snapshotSourceFamily(databasePath), before);
});

it.each([33, 34])(
  "prepares schema 35 from v%s with DDL only, retaining online conversion inputs",
  async (previousVersion) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("workspace-cas-migration-") };
    const pathname = resolveOpenClawStateSqlitePath(env);
    const options = { env, path: pathname };
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    let before: Record<string, unknown> | undefined;
    const nodeJson = '{"treeRef":"retained-root","canonicalIdentity":"retained-stat"}';
    {
      using source = openRawDatabase(pathname);
      source.exec(withLegacyLocalWorkspaceCas(OPENCLAW_STATE_SCHEMA_SQL));
      source.exec(`PRAGMA user_version = ${previousVersion};
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', ${previousVersion}, 1, 1);
      INSERT INTO local_workspace_projections
        (worktree_id, agent_id, session_key, session_id, projection_path, base_commit,
          source_paths_json, baseline_ref, checkpoint_json, pending_ref, pending_target,
          revision, created_at_ms)
        VALUES ('workspace', 'main', 'agent:main:workspace', 'session', '/synthetic/projection',
          'base', '["source.txt"]', 'retained-root', '{"pending":"checkpoint"}',
          'refs/openclaw/results/pending', 'canonical', 7, 1);`);
      source
        .prepare("INSERT INTO local_workspace_manifest_nodes VALUES (?, ?, ?)")
        .run("workspace", "source.txt", nodeJson);
      before = source.prepare("SELECT * FROM local_workspace_projections").get();
    }
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "local-workspace-cas-v35", path: pathname },
      { kind: "template-names-v36", path: pathname },
      { kind: "worker-resource-receipts-v37", path: pathname },
      { kind: "repository-disk-authority-v38", path: pathname },
    ]);
    await withStateMigrationBackupForTest(options, async () => {
      using witness = openRawDatabase(pathname);
      const database = await assertSqliteMigrationScopePreserved(
        witness,
        [
          "schema_meta",
          "config_machine_state",
          "local_workspace_projections",
          "local_workspace_tree_packs",
          "local_workspace_source_path_sets",
        ],
        () => openOpenClawStateDatabase(options),
      );
      expect(database.db.prepare("SELECT * FROM local_workspace_projections").get()).toEqual({
        ...before,
        tree_root_digest: null,
        source_paths_digest: null,
        canonical_fingerprints: null,
        projection_fingerprints: null,
      });
      expect(
        database.db.prepare("SELECT node_json FROM local_workspace_manifest_nodes").all(),
      ).toEqual([{ node_json: nodeJson }]);
      for (const table of ["local_workspace_tree_packs", "local_workspace_source_path_sets"]) {
        expect(database.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
          count: 0,
        });
      }
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
    });
  },
);
