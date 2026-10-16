import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { backupRestoreCommand } from "../../commands/backup-restore.js";
import { buildBackupArchivePath } from "../../commands/backup-shared.js";
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
import { readBackupEngine } from "../../snapshot/database-backup.js";
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
  it("rehydrates every family and retained Matrix root after the original namespaces are lost", async () => {
    assert(connection);
    await withOpenClawTestState({ scenario: "minimal", prefix: "pg-archive-" }, async (state) => {
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
        database: { engine: "postgres", postgres: { connection: isolated.href } },
        agents: { entries: { main: {} } },
        plugins: {
          entries: {
            workboard: { enabled: false },
            logbook: { enabled: false },
            "team-reports": { enabled: false },
            matrix: { enabled: false },
          },
        },
      };
      await state.writeConfig(config);
      const matrix = loadBundledPluginPublicArtifactModuleSync<{
        resolveMatrixAccountStorageRoot(params: {
          stateDir: string;
          homeserver: string;
          userId: string;
          accessToken: string;
          accountId: string;
        }): { rootDir: string };
      }>({ dirName: "matrix", artifactBasename: "runtime-api.js" });
      const matrixRoots = ["current", "retained"].map((accessToken) =>
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
      );
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
      ];
      const descriptors = new Map(
        await Promise.all(
          [...new Set(stores.map(({ family }) => family))].map(
            async (family) => [family, await loadDatabasePortDescriptor(family, config)] as const,
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
          namespaces.add(namespace);
          await fs.mkdir(path.dirname(store.file), { recursive: true });
          {
            using source = openNodeSqliteDatabase(":memory:");
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
              source.prepare("INSERT INTO standups VALUES ('2026-10-16', ?, 1)").run(store.value);
            } else {
              source.exec(
                "INSERT INTO team_reports_schema_migrations VALUES ('schema-1', 1787184000000)",
              );
            }
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
        const backup = await createBackupArchive({
          output: state.path("archive.tar.gz"),
          includeWorkspace: false,
        });
        const capturedRoot = state.path("captured-archive");
        await fs.mkdir(capturedRoot);
        await tar.x({ file: backup.archivePath, cwd: capturedRoot });
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
        const recoveryConfig: OpenClawConfig = {
          ...config,
          database: { engine: "postgres", postgres: { connection: recoveryConnection.href } },
        };
        await state.writeConfig(recoveryConfig);
        resetDatabaseEngineSelectionForTest();
        clearRuntimeConfigSnapshot();
        const targetPath = state.path("restored");
        const restored = await backupRestoreCommand(createTestRuntime(), {
          archive: backup.archivePath,
          target: targetPath,
        });
        for (const store of stores) {
          const anchor = readBackupEngine(
            path.join(targetPath, buildBackupArchivePath(restored.archiveRoot, store.file)),
          );
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
          (await client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'restore_%'"))
            .rows,
        ).toEqual([]);

        const plugin = stores.find((store) => store.family === "workboard")!;
        const legacyRoot = state.path("legacy-archive");
        const pluginEntry = buildBackupArchivePath(backup.archiveRoot, plugin.file);
        const legacyAnchor = path.join(legacyRoot, pluginEntry);
        await fs.mkdir(path.dirname(legacyAnchor), { recursive: true });
        await fs.copyFile(path.join(capturedRoot, pluginEntry), legacyAnchor);
        await fs.cp(
          path.join(capturedRoot, `${pluginEntry}.postgres`),
          `${legacyAnchor}.postgres`,
          { recursive: true },
        );
        await fs.writeFile(
          path.join(`${legacyAnchor}.postgres`, "operator-note.txt"),
          "retain this user file\n",
        );
        await fs.writeFile(
          path.join(legacyRoot, backup.archiveRoot, "manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            archiveRoot: backup.archiveRoot,
            createdAt: backup.createdAt,
            platform: process.platform,
            assets: [
              {
                kind: "state",
                sourcePath: path.dirname(plugin.file),
                archivePath: buildBackupArchivePath(backup.archiveRoot, path.dirname(plugin.file)),
              },
            ],
          }),
        );
        const legacyArchive = state.path("legacy.tar.gz");
        await tar.c({ file: legacyArchive, cwd: legacyRoot, gzip: true }, [backup.archiveRoot]);
        const legacyTarget = state.path("legacy-restored");
        resetDatabaseEngineSelectionForTest();
        clearRuntimeConfigSnapshot();
        await backupRestoreCommand(createTestRuntime(), {
          archive: legacyArchive,
          target: legacyTarget,
        });
        const legacy = readBackupEngine(path.join(legacyTarget, pluginEntry));
        assert(legacy.engine === "postgres");
        expect(
          (await recovery.query(`SELECT name FROM "${legacy.namespace}".workboard_boards`)).rows,
        ).toEqual([{ name: plugin.value }]);
        expect(
          await fs.readFile(
            path.join(legacyTarget, `${pluginEntry}.postgres`, "operator-note.txt"),
            "utf8",
          ),
        ).toBe("retain this user file\n");

        // Activate the restored anchors where this synthetic installation expects them.
        for (const store of stores) {
          await fs.copyFile(
            path.join(targetPath, buildBackupArchivePath(restored.archiveRoot, store.file)),
            store.file,
          );
        }
        const gatewayConfig: OpenClawConfig = {
          ...recoveryConfig,
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
          await resolveDatabaseEngineSelection(gatewayConfig, state.env),
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

        // A later unavailable provider must clean namespaces already prepared for earlier stores.
        const corruptRoot = state.path("corrupt");
        await fs.mkdir(corruptRoot);
        await tar.x({ file: backup.archivePath, cwd: corruptRoot });
        const archiveManifest = JSON.parse(
          await fs.readFile(path.join(corruptRoot, backup.archiveRoot, "manifest.json"), "utf8"),
        ) as { postgresSnapshots: Array<{ sourcePath: string }> };
        const lastPath = archiveManifest.postgresSnapshots.at(-1)!.sourcePath;
        const corruptManifest = path.join(
          corruptRoot,
          `${buildBackupArchivePath(backup.archiveRoot, lastPath)}.postgres`,
          "manifest.json",
        );
        const originalManifest = await fs.readFile(corruptManifest, "utf8");
        const unavailableProvider = JSON.parse(originalManifest);
        unavailableProvider.source.owner = "missing-backup-owner";
        await fs.writeFile(corruptManifest, JSON.stringify(unavailableProvider));
        const corruptArchive = state.path("corrupt.tar.gz");
        await tar.c({ file: corruptArchive, cwd: corruptRoot, gzip: true }, [backup.archiveRoot]);
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
        await fs.unlink(
          path.join(
            corruptRoot,
            `${buildBackupArchivePath(backup.archiveRoot, plugin.file)}.postgres`,
            "manifest.json",
          ),
        );
        const missingArchive = state.path("missing-capsule.tar.gz");
        await tar.c({ file: missingArchive, cwd: corruptRoot, gzip: true }, [backup.archiveRoot]);
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
    });
  }, 240_000);
});
