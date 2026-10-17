import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../../commands/backup-restore.js";
import { buildBackupArchivePath } from "../../commands/backup-shared.js";
import { verifyBackupArchive } from "../../commands/backup-verify.js";
import { createTestRuntime } from "../../commands/test-runtime-config-helpers.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { startGatewayServer } from "../../gateway/server.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../../gateway/test-helpers.listener.js";
import { resetLogger } from "../../logging/logger.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { clearSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { capturePostgresBackup, readBackupEngine } from "../../snapshot/database-backup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "../backup-create.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { loadDatabasePortDescriptor } from "./port-provider-descriptor.js";
import { materializeDatabasePort } from "./port.worker.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("whole-archive PostgreSQL restore", () => {
  it.each([
    {
      scenario: "all",
      name: "rehydrates every family and retained Matrix root before Gateway startup",
    },
    {
      scenario: "mixed",
      name: "publishes recovered PostgreSQL and SQLite selection from a captured config alias last",
    },
    {
      scenario: "compatibility",
      name: "preserves unlisted legacy exports and cleans failed provider restores",
    },
  ])(
    "$name",
    async ({ scenario }) => {
      const sqliteAgent = scenario === "mixed";
      assert(connection);
      await withEnvAsync(
        { OPENCLAW_ARCHIVE_TEST_PG: connection, OPENCLAW_INCLUDE_ROOTS: undefined },
        async () => {
          await withOpenClawTestState(
            { scenario: "minimal", prefix: "pg-archive-" },
            async (state) => {
              const database = `archive_test_${randomUUID().replaceAll("-", "")}`;
              const recoveryDatabase = `archive_recovery_${randomUUID().replaceAll("-", "")}`;
              const isolated = new URL(connection);
              isolated.pathname = `/${database}`;
              const recoveryConnection = new URL(connection);
              recoveryConnection.pathname = `/${recoveryDatabase}`;
              const admin = new Client({ connectionString: connection });
              const client = new Client({ connectionString: isolated.href });
              const recovery = new Client({ connectionString: recoveryConnection.href });
              const namespaces = new Set<string>();
              const config: OpenClawConfig = {
                database: {
                  engine: "postgres",
                  ...(sqliteAgent ? { families: { agent: { engine: "sqlite" as const } } } : {}),
                  postgres: {
                    connection: {
                      source: "env",
                      provider: "default",
                      id: "OPENCLAW_ARCHIVE_TEST_PG",
                    },
                  },
                },
                agents: {
                  ...(sqliteAgent ? { defaults: { workspace: state.path("workspace") } } : {}),
                  entries: { main: {} },
                },
                plugins: {
                  entries: {
                    workboard: { enabled: false },
                    logbook: { enabled: false },
                    "team-reports": { enabled: false },
                    matrix: { enabled: false },
                  },
                },
              };
              process.env.OPENCLAW_ARCHIVE_TEST_PG = isolated.href;
              const includePath = state.path("external-config", "database.json5");
              const configSourcePath = sqliteAgent
                ? state.path("external-config", "openclaw.json")
                : state.configPath;
              if (sqliteAgent) {
                await fs.mkdir(path.dirname(includePath), { recursive: true });
                await fs.writeFile(includePath, JSON.stringify({ database: config.database }));
                process.env.OPENCLAW_INCLUDE_ROOTS = path.dirname(includePath);
                const { database: _database, ...withoutDatabase } = config;
                await state.writeConfig({ ...withoutDatabase, $include: includePath });
                await fs.rename(state.configPath, configSourcePath);
                await fs.symlink(configSourcePath, state.configPath);
              } else {
                await state.writeConfig(config);
              }
              const configBytes = await fs.readFile(state.configPath);
              const matrix =
                scenario === "all"
                  ? loadBundledPluginPublicArtifactModuleSync<{
                      resolveMatrixAccountStorageRoot(params: {
                        stateDir: string;
                        homeserver: string;
                        userId: string;
                        accessToken: string;
                        accountId: string;
                      }): { rootDir: string };
                    }>({ dirName: "matrix", artifactBasename: "runtime-api.js" })
                  : undefined;
              const matrixRoots = matrix
                ? ["current", "retained"].map((accessToken) =>
                    path.join(
                      matrix.resolveMatrixAccountStorageRoot({
                        stateDir: state.stateDir,
                        homeserver: "https://matrix.example.org",
                        userId: "@synthetic:example.org",
                        accessToken: `synthetic-${accessToken}`,
                        accountId: "archive",
                      }).rootDir,
                      "state",
                      "openclaw.sqlite",
                    ),
                  )
                : [];
              const stores = [
                {
                  family: "state",
                  file: state.statePath("state", "openclaw.sqlite"),
                  table: "user_profiles",
                  column: "display_name",
                  value: "Global retained",
                },
                {
                  family: "agent",
                  file: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
                  table: "cache_entries",
                  column: "value_json",
                  value: '"Agent retained"',
                },
                {
                  family: "workboard",
                  file: state.statePath("plugins", "workboard", "workboard.sqlite"),
                  table: "workboard_boards",
                  column: "name",
                  value: "Workboard retained",
                },
                {
                  family: "logbook",
                  file: state.statePath("logbook", "logbook.sqlite"),
                  table: "standups",
                  column: "text",
                  value: "Logbook retained",
                },
                {
                  family: "team-reports",
                  file: state.statePath("plugins", "team-reports", "team-reports.sqlite"),
                  table: "team_reports_schema_migrations",
                  column: "id",
                  value: "schema-1",
                },
                ...matrixRoots.map((file, index) => ({
                  family: "state",
                  file,
                  table: "plugin_state_entries",
                  column: "value_json",
                  value: JSON.stringify({ matrix: index }),
                })),
              ].filter(
                ({ family }) =>
                  scenario === "all" ||
                  (scenario === "mixed"
                    ? family === "state" || family === "agent"
                    : family === "state" || family === "workboard"),
              );
              const descriptors = new Map(
                await Promise.all(
                  [...new Set(stores.map(({ family }) => family))].map(
                    async (family) =>
                      [family, await loadDatabasePortDescriptor(family, config)] as const,
                  ),
                ),
              );
              await admin.connect();
              try {
                await admin.query(`CREATE DATABASE "${database}"`);
                await admin.query(`CREATE DATABASE "${recoveryDatabase}"`);
                await client.connect();
                await recovery.connect();
                await client.query(
                  "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent",
                );
                await recovery.query(
                  "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent",
                );
                for (const store of stores) {
                  const descriptor = descriptors.get(store.family)!;
                  const namespace = `archive_${randomUUID().replaceAll("-", "")}`;
                  const storeId = randomUUID();
                  await fs.mkdir(path.dirname(store.file), { recursive: true });
                  {
                    using source = openNodeSqliteDatabase(
                      sqliteAgent && store.family === "agent" ? store.file : ":memory:",
                    );
                    source.exec(descriptor.sqlite);
                    for (const fragment of descriptor.fragments ?? []) {
                      source.exec(fragment.sqlite);
                    }
                    if (store.family === "state") {
                      source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
                INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
                INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION}', 1);`);
                      if (matrixRoots.includes(store.file)) {
                        source
                          .prepare(
                            "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES ('matrix', 'idb-snapshot', 'chunk', ?, 1)",
                          )
                          .run(store.value);
                      } else {
                        source
                          .prepare(
                            "INSERT INTO user_profiles (id, display_name, created_at, updated_at) VALUES ('profile', ?, 1, 1)",
                          )
                          .run(store.value);
                      }
                    } else if (store.family === "agent") {
                      source.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
                INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
                INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);`);
                      source
                        .prepare(
                          "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('archive', 'retained', ?, 1)",
                        )
                        .run(store.value);
                    } else if (store.family === "workboard") {
                      source
                        .prepare(
                          "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('board', ?, 1, 1)",
                        )
                        .run(store.value);
                    } else if (store.family === "logbook") {
                      source.exec("PRAGMA user_version = 1");
                      source
                        .prepare("INSERT INTO standups VALUES ('2026-10-16', ?, 1)")
                        .run(store.value);
                    } else {
                      source.exec(
                        "INSERT INTO team_reports_schema_migrations VALUES ('schema-1', 1787184000000)",
                      );
                    }
                    if (sqliteAgent && store.family === "agent") {
                      continue;
                    }
                    namespaces.add(namespace);
                    await materializeDatabasePort({
                      source: { engine: "sqlite", db: source },
                      destination: { engine: "postgres", db: client, namespace },
                      descriptor,
                      storeId,
                      assertCurrent() {},
                    });
                  }
                  using anchor = openNodeSqliteDatabase(store.file);
                  anchor.exec(
                    "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
                  );
                  anchor
                    .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
                    .run(storeId, namespace);
                }
                resetDatabaseEngineSelectionForTest();
                clearRuntimeConfigSnapshot();
                const userExportPath = state.path("workspace", "copied.sqlite");
                const userFiles = new Map<string, Buffer>();
                if (sqliteAgent) {
                  await fs.mkdir(path.dirname(userExportPath), { recursive: true });
                  await capturePostgresBackup({
                    sourcePath: stores[0]!.file,
                    directory: `${userExportPath}.postgres`,
                  });
                  await fs.copyFile(`${userExportPath}.postgres/anchor.sqlite`, userExportPath);
                  for (const file of [
                    userExportPath,
                    ...["manifest.json", "anchor.sqlite", "database.sqlite"].map(
                      (name) => `${userExportPath}.postgres/${name}`,
                    ),
                  ]) {
                    userFiles.set(file, await fs.readFile(file));
                  }
                }
                const backup = await createBackupArchive({
                  output: state.path("archive.tar.gz"),
                  includeWorkspace: sqliteAgent,
                });
                const capturedIdentities = new Map(
                  stores.map((store) => [store.file, readBackupEngine(store.file)]),
                );
                await closeStateDatabaseForTest();
                for (const namespace of namespaces) {
                  await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
                }
                for (const store of stores) {
                  await fs.unlink(store.file);
                }
                process.env.OPENCLAW_ARCHIVE_TEST_PG = recoveryConnection.href;
                if (sqliteAgent) {
                  await fs.writeFile(
                    includePath,
                    JSON.stringify({ database: { engine: "sqlite" } }),
                  );
                }
                // The archived selection, not the current installation, must drive recovery.
                await state.writeConfig({ database: { engine: "sqlite" } });
                resetDatabaseEngineSelectionForTest();
                clearRuntimeConfigSnapshot();
                if (scenario !== "compatibility") {
                  const targetPath = state.path("restored");
                  const restoredConfig = path.join(
                    targetPath,
                    buildBackupArchivePath(backup.archiveRoot, configSourcePath),
                  );
                  const rename = fs.rename.bind(fs);
                  let selectionPublished = false;
                  const publication = vi
                    .spyOn(fs, "rename")
                    .mockImplementation(async (source, destination) => {
                      if (destination === restoredConfig) {
                        await expect(fs.access(restoredConfig)).rejects.toMatchObject({
                          code: "ENOENT",
                        });
                        for (const store of stores) {
                          const anchor = readBackupEngine(
                            path.join(
                              targetPath,
                              buildBackupArchivePath(backup.archiveRoot, store.file),
                            ),
                          );
                          expect(anchor.engine).toBe(
                            sqliteAgent && store.family === "agent" ? "sqlite" : "postgres",
                          );
                          if (anchor.engine === "postgres") {
                            expect(namespaces.has(anchor.namespace)).toBe(false);
                            expect(
                              (
                                await recovery.query(
                                  `SELECT "${store.column}" AS value FROM "${anchor.namespace}"."${store.table}"`,
                                )
                              ).rows,
                            ).toEqual([{ value: store.value }]);
                          }
                        }
                        selectionPublished = true;
                      }
                      await rename(source, destination);
                    });
                  let restored: Awaited<ReturnType<typeof backupRestoreCommand>>;
                  try {
                    restored = await backupRestoreCommand(createTestRuntime(), {
                      archive: backup.archivePath,
                      target: targetPath,
                    });
                  } finally {
                    publication.mockRestore();
                  }
                  expect(selectionPublished).toBe(true);
                  for (const [file, bytes] of userFiles) {
                    expect(
                      await fs.readFile(
                        path.join(targetPath, buildBackupArchivePath(backup.archiveRoot, file)),
                      ),
                    ).toEqual(bytes);
                  }
                  expect(
                    (
                      await recovery.query(
                        "SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'restore_%'",
                      )
                    ).rows,
                  ).toEqual([
                    {
                      count: stores.filter((store) => !sqliteAgent || store.family !== "agent")
                        .length,
                    },
                  ]);
                  for (const store of stores) {
                    const anchor = readBackupEngine(
                      path.join(
                        targetPath,
                        buildBackupArchivePath(restored.archiveRoot, store.file),
                      ),
                    );
                    if (sqliteAgent && store.family === "agent") {
                      expect(anchor).toEqual({ engine: "sqlite" });
                      using restoredAgent = openNodeSqliteDatabase(
                        path.join(
                          targetPath,
                          buildBackupArchivePath(restored.archiveRoot, store.file),
                        ),
                      );
                      expect(
                        restoredAgent
                          .prepare(
                            "SELECT value_json AS value FROM cache_entries WHERE scope = 'archive'",
                          )
                          .all(),
                      ).toEqual([{ value: store.value }]);
                      continue;
                    }
                    assert(anchor.engine === "postgres");
                    expect(namespaces.has(anchor.namespace)).toBe(false);
                    expect(anchor).toMatchObject({
                      ...capturedIdentities.get(store.file),
                      namespace: anchor.namespace,
                    });
                    namespaces.add(anchor.namespace);
                    expect(
                      (
                        await recovery.query(
                          `SELECT "${store.column}" AS value FROM "${anchor.namespace}"."${store.table}"`,
                        )
                      ).rows,
                    ).toEqual([{ value: store.value }]);
                    for (const name of ["manifest.json", "anchor.sqlite", "database.sqlite"]) {
                      await expect(
                        fs.access(
                          path.join(
                            targetPath,
                            `${buildBackupArchivePath(restored.archiveRoot, store.file)}.postgres`,
                            name,
                          ),
                        ),
                      ).rejects.toMatchObject({ code: "ENOENT" });
                    }
                  }
                  expect(
                    (
                      await client.query(
                        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'restore_%'",
                      )
                    ).rows,
                  ).toEqual([]);

                  expect(await fs.readFile(restoredConfig)).toEqual(configBytes);

                  // Activate the entire restored state asset, including any retained capsule directories.
                  await fs.cp(
                    path.join(
                      targetPath,
                      buildBackupArchivePath(backup.archiveRoot, state.stateDir),
                    ),
                    state.stateDir,
                    { recursive: true },
                  );
                  const gatewayConfig: OpenClawConfig = {
                    ...config,
                    plugins: { enabled: false },
                    gateway: {
                      mode: "local",
                      auth: { mode: "token", token: "archive-synthetic-token" },
                      controlUi: { enabled: false },
                    },
                    skills: { load: { watch: false } },
                    logging: { level: "silent", consoleLevel: "silent" },
                    meta: { migrations: { webhookListeners: true } },
                  };
                  await state.writeConfig(gatewayConfig);
                  setRuntimeConfigSnapshot(gatewayConfig);
                  installDatabaseEngineSelection(
                    await resolveDatabaseEngineSelection(gatewayConfig),
                  );
                  await withEnvAsync(
                    {
                      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
                      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
                      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
                      OPENCLAW_SKIP_CANVAS_HOST: "1",
                      OPENCLAW_SKIP_CHANNELS: "1",
                      OPENCLAW_SKIP_CRON: "1",
                      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
                      OPENCLAW_SKIP_PROVIDERS: "1",
                    },
                    async () => {
                      const claim = await acquireGatewayE2ePortBlock();
                      const lock = await acquireGatewayLock({
                        env: state.env,
                        port: claim.port,
                        listenerMode: "foreground",
                        allowInTests: true,
                      });
                      assert(lock);
                      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
                      try {
                        server = await startClaimedGateway(claim, () =>
                          startGatewayServer(claim.port, {
                            gatewayStateOwner: lock,
                            bind: "loopback",
                            controlUiEnabled: false,
                          }),
                        );
                        await server.startupSettled;
                        const anchor = readBackupEngine(stores[0]!.file);
                        expect(anchor).toEqual(
                          readBackupEngine(
                            path.join(
                              targetPath,
                              buildBackupArchivePath(restored.archiveRoot, stores[0]!.file),
                            ),
                          ),
                        );
                      } finally {
                        await server?.close({ reason: "archive restore proof" });
                        await lock.release();
                        await claim.release();
                        await closeStateDatabaseForTest();
                      }
                    },
                  );
                  if (sqliteAgent) {
                    clearRuntimeConfigSnapshot();
                    resetDatabaseEngineSelectionForTest();
                    const next = await createBackupArchive({
                      output: state.path("after-restore.tar.gz"),
                      includeWorkspace: false,
                    });
                    await expect(verifyBackupArchive(next.archivePath)).resolves.toMatchObject({
                      ok: true,
                    });
                    const nextRoot = state.path("next-capture");
                    await fs.mkdir(nextRoot);
                    await tar.x({ file: next.archivePath, cwd: nextRoot });
                    const nextManifest = JSON.parse(
                      await fs.readFile(
                        path.join(nextRoot, next.archiveRoot, "manifest.json"),
                        "utf8",
                      ),
                    );
                    expect(nextManifest.postgresSnapshots).toHaveLength(
                      stores.filter((store) => store.family !== "agent").length,
                    );
                  }
                } else {
                  const capturedRoot = state.path("captured-archive");
                  await fs.mkdir(capturedRoot);
                  await tar.x({ file: backup.archivePath, cwd: capturedRoot });
                  const plugin = stores.find((store) => store.family === "workboard")!;
                  const legacyRoot = state.path("legacy-archive");
                  const pluginEntry = buildBackupArchivePath(backup.archiveRoot, plugin.file);
                  await fs.cp(capturedRoot, legacyRoot, { recursive: true });
                  const legacyAnchor = path.join(legacyRoot, pluginEntry);
                  await fs.writeFile(
                    path.join(`${legacyAnchor}.postgres`, "operator-note.txt"),
                    "retain this user file\n",
                  );
                  const legacyManifestPath = path.join(
                    legacyRoot,
                    backup.archiveRoot,
                    "manifest.json",
                  );
                  const legacyManifest = JSON.parse(await fs.readFile(legacyManifestPath, "utf8"));
                  delete legacyManifest.postgresSnapshots;
                  await fs.writeFile(legacyManifestPath, JSON.stringify(legacyManifest));
                  const legacyFiles = new Map<string, Buffer>();
                  for (const entryPath of [
                    pluginEntry,
                    ...[
                      "manifest.json",
                      "anchor.sqlite",
                      "database.sqlite",
                      "operator-note.txt",
                    ].map((name) => `${pluginEntry}.postgres/${name}`),
                  ]) {
                    legacyFiles.set(entryPath, await fs.readFile(path.join(legacyRoot, entryPath)));
                  }
                  const legacyArchive = state.path("legacy.tar.gz");
                  await tar.c({ file: legacyArchive, cwd: legacyRoot, gzip: true }, [
                    backup.archiveRoot,
                  ]);
                  const legacyTarget = state.path("legacy-restored");
                  resetDatabaseEngineSelectionForTest();
                  clearRuntimeConfigSnapshot();
                  const legacyResult = await backupRestoreCommand(createTestRuntime(), {
                    archive: legacyArchive,
                    target: legacyTarget,
                  });
                  expect(legacyResult.warnings).toContainEqual(
                    expect.stringContaining("Re-run backup with this version"),
                  );
                  for (const [name, bytes] of legacyFiles) {
                    expect(await fs.readFile(path.join(legacyTarget, name))).toEqual(bytes);
                  }
                  const global = stores.find((store) => store.family === "state")!;
                  const legacy = readBackupEngine(
                    path.join(
                      legacyTarget,
                      buildBackupArchivePath(backup.archiveRoot, global.file),
                    ),
                  );
                  assert(legacy.engine === "postgres");
                  expect(
                    (
                      await recovery.query(
                        `SELECT display_name FROM "${legacy.namespace}".user_profiles`,
                      )
                    ).rows,
                  ).toEqual([{ display_name: global.value }]);
                  expect(
                    (
                      await recovery.query(
                        "SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'restore_%'",
                      )
                    ).rows,
                  ).toEqual([{ count: 1 }]);

                  // A later unavailable provider must clean namespaces already prepared for earlier stores.
                  const corruptRoot = state.path("corrupt");
                  await fs.mkdir(corruptRoot);
                  await tar.x({ file: backup.archivePath, cwd: corruptRoot });
                  const archiveManifestPath = path.join(
                    corruptRoot,
                    backup.archiveRoot,
                    "manifest.json",
                  );
                  const archiveManifest = JSON.parse(
                    await fs.readFile(archiveManifestPath, "utf8"),
                  ) as {
                    postgresSnapshots: Array<{ archivePath: string; manifestSha256: string }>;
                  };
                  const lastCapture = archiveManifest.postgresSnapshots.at(-1)!;
                  const originalHash = lastCapture.manifestSha256;
                  const corruptManifest = path.join(
                    corruptRoot,
                    lastCapture.archivePath,
                    "manifest.json",
                  );
                  const originalManifest = await fs.readFile(corruptManifest, "utf8");
                  const unavailableProvider = JSON.parse(originalManifest);
                  unavailableProvider.source.owner = "missing-backup-owner";
                  await fs.writeFile(corruptManifest, JSON.stringify(unavailableProvider));
                  lastCapture.manifestSha256 = createHash("sha256")
                    .update(await fs.readFile(corruptManifest))
                    .digest("hex");
                  await fs.writeFile(archiveManifestPath, JSON.stringify(archiveManifest));
                  const corruptArchive = state.path("corrupt.tar.gz");
                  await tar.c({ file: corruptArchive, cwd: corruptRoot, gzip: true }, [
                    backup.archiveRoot,
                  ]);
                  const before = (
                    await recovery.query(
                      "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'restore_%' ORDER BY nspname",
                    )
                  ).rows;
                  resetDatabaseEngineSelectionForTest();
                  clearRuntimeConfigSnapshot();
                  await expect(
                    backupRestoreCommand(createTestRuntime(), {
                      archive: corruptArchive,
                      target: state.path("failed"),
                    }),
                  ).rejects.toThrow("incomplete target was cleaned");
                  expect(
                    (
                      await recovery.query(
                        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'restore_%' ORDER BY nspname",
                      )
                    ).rows,
                  ).toEqual(before);

                  await fs.writeFile(corruptManifest, originalManifest);
                  lastCapture.manifestSha256 = originalHash;
                  await fs.writeFile(archiveManifestPath, JSON.stringify(archiveManifest));
                  await fs.unlink(
                    path.join(
                      corruptRoot,
                      `${buildBackupArchivePath(backup.archiveRoot, plugin.file)}.postgres`,
                      "manifest.json",
                    ),
                  );
                  const missingArchive = state.path("missing-capsule.tar.gz");
                  await tar.c({ file: missingArchive, cwd: corruptRoot, gzip: true }, [
                    backup.archiveRoot,
                  ]);
                  resetDatabaseEngineSelectionForTest();
                  clearRuntimeConfigSnapshot();
                  await expect(
                    backupRestoreCommand(createTestRuntime(), {
                      archive: missingArchive,
                      target: state.path("missing-capsule"),
                    }),
                  ).rejects.toThrow("manifest.json");
                  expect(
                    (
                      await recovery.query(
                        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'restore_%' ORDER BY nspname",
                      )
                    ).rows,
                  ).toEqual(before);
                }
              } finally {
                try {
                  await closeStateDatabaseForTest();
                  clearRuntimeConfigSnapshot();
                  resetDatabaseEngineSelectionForTest();
                  clearSecretsRuntimeSnapshot();
                  resetLogger();
                  await client.end();
                  await recovery.end();
                  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
                  await admin.query(`DROP DATABASE IF EXISTS "${recoveryDatabase}" WITH (FORCE)`);
                } finally {
                  await admin.end();
                }
              }
            },
          );
        },
      );
    },
    240_000,
  );
});
