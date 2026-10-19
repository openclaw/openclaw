import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import "./backup-worker.test-support.js";
import { createBackupResourcePlan } from "../../commands/backup-resource-inventory.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveActivatedPluginBackupInventory } from "../../plugins/manifest-backup-resources.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import {
  capturePostgresBackup,
  preparePostgresRestore,
  readBackupEngine,
  verifyMatchedPostgresBackup,
} from "../../snapshot/database-backup.js";
import {
  dumpGitBackupDatabase,
  restoreGitBackupDirectory,
} from "../../snapshot/git-backup-codec.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createBackupSqliteSnapshotPlan } from "../backup-sqlite-snapshot.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "../client-credential-schema.js";
import { resolveClientCredentialStorePath } from "../client-credential-store.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import * as snapshotSource from "../sqlite-snapshot-source.js";
import { createUpdateStateInspectionDiagnostics } from "../update-candidate-state.diagnostics.js";
import * as inspection from "../update-candidate-state.inspection.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  UpdateStateSchemaInspectionPlanSchema,
} from "../update-candidate-state.js";
import * as databaseSizes from "../update-candidate-state.sizes.js";
import {
  createUpdateDatabaseBackup,
  createUpdateDatabaseBackupInProcess,
} from "../update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../update-database-restore.js";
import { createUpdateRun } from "../update-run-ledger.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { withDatabaseEngineSelection } from "./context.js";
import { loadDatabasePortDescriptor } from "./port-provider-descriptor.js";
import { materializeDatabasePort, type PortDescriptor } from "./port.worker.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import { statePortProvider } from "./state-port.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const canonicalText = ' {"first":1,"first":2,"escaped":"\\u0000"} \n';

async function expectRestored(client: Client, namespace: string) {
  expect(
    (
      await client.query(
        `SELECT title, automation_json, created_at FROM "${namespace}".workboard_cards`,
      )
    ).rows,
  ).toEqual([
    { title: "Retained 🦞", automation_json: canonicalText, created_at: "9007199254740993" },
  ]);
  expect(
    (await client.query(`SELECT sequence FROM "${namespace}".workboard_card_notifications`)).rows,
  ).toEqual([{ sequence: "9007199254740995" }]);
  expect(
    (await client.query(`SELECT content FROM "${namespace}".workboard_attachment_blobs`)).rows,
  ).toEqual([{ content: Buffer.from([0, 255, 128, 1]) }]);
}

describe.skipIf(!connection)("matched PostgreSQL backup and update recovery", () => {
  it("restores user and Git exports and exact updater state while preserving source data and sidecars", async () => {
    assert(connection);
    await withOpenClawTestState({ scenario: "minimal", prefix: "pg-backup-" }, async (state) => {
      const client = new Client({ connectionString: connection });
      const namespace = `backup_${randomUUID().replaceAll("-", "")}`;
      const namespaces = new Set([namespace]);
      const storeId = randomUUID();
      const anchorPath = state.statePath("plugins", "workboard", "workboard.sqlite");
      const config: OpenClawConfig = {
        database: { families: { workboard: { engine: "postgres" } }, postgres: { connection } },
        plugins: { entries: { workboard: { enabled: true } } },
      };
      await state.writeConfig(config);
      await fs.mkdir(path.dirname(anchorPath), { recursive: true });
      await client.connect();
      try {
        const postgres = await fs.readFile(
          new URL(
            "../../../extensions/workboard/src/workboard-schema.postgres.sql",
            import.meta.url,
          ),
          "utf8",
        );
        const descriptor: PortDescriptor = {
          ...metadata,
          preData: postgres.slice(metadata.preData[0], metadata.preData[1]),
          postData: postgres.slice(metadata.postData[0], metadata.postData[1]),
          expectedCatalog: expectedPostgresCatalog(metadata),
        };
        {
          using source = openNodeSqliteDatabase(":memory:", { readBigInts: true });
          source.exec(descriptor.sqlite);
          source.exec(
            "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('board', '', -9223372036854775808, 9223372036854775807)",
          );
          source
            .prepare(
              "INSERT INTO workboard_cards (id, board_id, title, status, priority, position, created_at, updated_at, automation_json) VALUES ('card', 'board', 'Retained 🦞', 'todo', 'normal', 0.5, 9007199254740993, 1, ?)",
            )
            .run(canonicalText);
          source.exec(`
            INSERT INTO workboard_attachment_blobs VALUES ('blob', x'00ff8001');
            INSERT INTO workboard_card_notifications (id, card_id, ordinal, kind, message, created_at, sequence)
            VALUES ('notification', 'card', 1, 'status', 'line one\nline two', 3, 9007199254740995);
          `);
          await materializeDatabasePort({
            source: { engine: "sqlite", db: source },
            destination: { engine: "postgres", db: client, namespace },
            descriptor,
            storeId,
            assertCurrent() {},
          });
        }
        {
          using anchor = openNodeSqliteDatabase(anchorPath);
          anchor.exec(
            "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)",
          );
          anchor
            .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
            .run(storeId, namespace);
        }
        openOpenClawStateDatabase({ env: state.env });
        await closeOpenClawStateDatabaseAsync();
        const credentialsPath = resolveClientCredentialStorePath(state.env);
        await fs.mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
        {
          using credentials = openNodeSqliteDatabase(credentialsPath);
          credentials.exec(CLIENT_CREDENTIAL_SCHEMA_SQL);
          credentials.exec("PRAGMA user_version = 1");
          credentials
            .prepare("INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?)")
            .run("synthetic-device", "operator", "synthetic-token", "[]", 1);
          credentials
            .prepare("INSERT INTO native_exec_socket_credentials VALUES (?, ?, ?, ?)")
            .run("current", "/synthetic/native.sock", "synthetic-socket-token", 1);
        }
        const inventory = resolveActivatedPluginBackupInventory({
          config,
          env: state.env,
          stateDir: state.stateDir,
        });
        {
          const originalAnchor = await fs.readFile(anchorPath);
          const resources = await createBackupResourcePlan({
            stateDir: state.stateDir,
            configPaths: [],
            oauthDirs: [],
            workspaceDirs: [],
            excludedWorkspaceDirs: [],
            agentRoots: [],
            pluginResources: inventory.resources,
            pluginRoots: inventory.pluginRoots,
          });
          const tempDir = state.path("archive-staging");
          await fs.mkdir(tempDir);
          const plan = await createBackupSqliteSnapshotPlan({
            resources,
            tempDir,
            legacyAuditSnapshots: [],
          });
          expect(plan.inventory.resolveSqliteSource(credentialsPath)?.role).toBe("client");
          const credentialsAsset = plan.snapshots.find(
            (asset) => asset.archiveSourcePath === credentialsPath,
          );
          expect(credentialsAsset).toBeDefined();
          expect(readBackupEngine(credentialsAsset!.sourcePath)).toEqual({ engine: "sqlite" });
          expect(
            plan.snapshots.some((asset) =>
              asset.archiveSourcePath.startsWith(`${credentialsPath}.postgres/`),
            ),
          ).toBe(false);
          {
            using credentials = openNodeSqliteDatabase(credentialsAsset!.sourcePath, {
              readOnly: true,
            });
            expect(credentials.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
              token: "synthetic-token",
            });
            expect(
              credentials.prepare("SELECT socket_token FROM native_exec_socket_credentials").get(),
            ).toEqual({ socket_token: null });
          }
          {
            using original = openNodeSqliteDatabase(credentialsPath, { readOnly: true });
            expect(
              original.prepare("SELECT socket_token FROM native_exec_socket_credentials").get(),
            ).toEqual({ socket_token: "synthetic-socket-token" });
          }
          const capsule = plan.snapshots.filter((asset) =>
            asset.archiveSourcePath.startsWith(`${anchorPath}.postgres/`),
          );
          expect(capsule).toHaveLength(3);
          const directory = state.path("extracted", "workboard.sqlite.postgres");
          await fs.mkdir(directory, { recursive: true });
          for (const asset of capsule) {
            await fs.copyFile(
              asset.sourcePath,
              path.join(directory, path.basename(asset.archiveSourcePath)),
            );
          }
          const manifest = await verifyMatchedPostgresBackup(directory, "user-backup");
          expect(manifest).toMatchObject({
            profile: "user-backup",
            source: { engine: "postgres", namespace, storeId },
          });
          expect(JSON.stringify(manifest)).not.toContain(connection);
          expect(manifest.sanitizedDifferences).toEqual([]);
          expect(await fs.readFile(anchorPath)).toEqual(originalAnchor);
          await expect(verifyMatchedPostgresBackup(directory, "exact")).rejects.toThrow();
          await expect(verifyMatchedPostgresBackup(directory, "user-backup")).resolves.toEqual(
            manifest,
          );
          const restoredAnchor = state.path("restored.sqlite");
          const restored = await preparePostgresRestore({
            directory,
            anchorPath: restoredAnchor,
            config,
            profile: "user-backup",
            assertCurrent() {},
          });
          namespaces.add(restored.namespace);
          expect(restored.namespace).not.toBe(namespace);
          expect(readBackupEngine(restoredAnchor)).toEqual({
            engine: "postgres",
            namespace: restored.namespace,
            storeId,
          });
          await expectRestored(client, restored.namespace);
          await expectRestored(client, namespace);
          {
            using wrong = openNodeSqliteDatabase(path.join(directory, "anchor.sqlite"));
            wrong.prepare("UPDATE openclaw_engine_anchor SET store_id = ?").run(randomUUID());
          }
          await expect(verifyMatchedPostgresBackup(directory, "user-backup")).rejects.toThrow();
        }
        {
          const capturedSelection = await resolveDatabaseEngineSelection(config);
          const unavailableConfig: OpenClawConfig = {
            ...config,
            database: {
              ...config.database,
              postgres: {
                connection: {
                  source: "env",
                  provider: "default",
                  id: `OPENCLAW_UNAVAILABLE_BACKUP_${randomUUID().replaceAll("-", "").toUpperCase()}`,
                },
              },
            },
          };
          await expect(resolveDatabaseEngineSelection(unavailableConfig)).rejects.toThrow(
            "Configure a resolvable PostgreSQL DSN",
          );
          await withDatabaseEngineSelection(capturedSelection, async () => {
            const directory = state.path("captured-selection-backup");
            const reacquire = vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocationSync");
            const isolatePrivate = vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocation");
            await capturePostgresBackup({
              sourcePath: anchorPath,
              directory,
              config: unavailableConfig,
              profile: "user-backup",
              assertCurrent() {},
            });
            // The verified anchor image is the identity source; do not copy the live anchor twice.
            expect(reacquire.mock.calls.filter(([file]) => file === anchorPath)).toHaveLength(0);
            expect(
              isolatePrivate.mock.calls.filter(
                ([file]) => path.basename(file) === ".export.sqlite",
              ),
            ).toHaveLength(0);
            reacquire.mockRestore();
            isolatePrivate.mockRestore();
            const restored = await preparePostgresRestore({
              directory,
              anchorPath: state.path("captured-selection-restored.sqlite"),
              config: unavailableConfig,
              profile: "user-backup",
              assertCurrent() {},
            });
            namespaces.add(restored.namespace);
            expect(restored.namespace).not.toBe(namespace);
            await expectRestored(client, restored.namespace);
          });
        }
        {
          const gitPath = state.path("git-backup");
          const identity = { role: "generic", id: "workboard" } as const;
          const gitManifest = await dumpGitBackupDatabase({
            snapshotPath: anchorPath,
            outputPath: gitPath,
            identity,
          });
          expect(gitManifest.schemaVersion).toBe(2);
          const gitTarget = state.path("git-restored.sqlite");
          await restoreGitBackupDirectory({
            sourcePath: gitPath,
            targetPath: gitTarget,
            expectedIdentity: identity,
          });
          const gitAnchor = readBackupEngine(gitTarget);
          assert(gitAnchor.engine === "postgres");
          namespaces.add(gitAnchor.namespace);
          expect(gitAnchor.storeId).toBe(storeId);
          expect(gitAnchor.namespace).not.toBe(namespace);
          await expectRestored(client, gitAnchor.namespace);
        }
        {
          // The later exact-update recovery exercises the homogeneous PostgreSQL selection.
          config.database = { engine: "postgres", postgres: { connection } };
          await state.writeConfig(config);
          openOpenClawStateDatabase({ env: state.env });
          createUpdateRun({ trigger: "cli" }, { env: state.env });
          await closeOpenClawStateDatabaseAsync();
          {
            const sharedPath = state.statePath("state", "openclaw.sqlite");
            using shared = openNodeSqliteDatabase(sharedPath);
            shared.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            shared
              .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
              .run("team-reports.fixture", "{}", 1);
            const capture = () =>
              ["", "-wal", "-shm", "-journal"].map((suffix) => {
                const file = `${sharedPath}${suffix}`;
                if (!fsSync.existsSync(file)) {
                  return null;
                }
                const { ino, size, mtimeNs, ctimeNs } = fsSync.statSync(file, { bigint: true });
                return { ino, size, mtimeNs, ctimeNs, bytes: fsSync.readFileSync(file) };
              });
            const before = capture();
            expect(before[1]?.size).toBeGreaterThan(0n);
            expect(before[2]).not.toBeNull();
            await withPluginCache(createPluginCache(), () =>
              loadDatabasePortDescriptor("team-reports", {
                plugins: {
                  load: {
                    paths: [
                      fileURLToPath(new URL("../../../extensions/team-reports", import.meta.url)),
                    ],
                  },
                  entries: { "team-reports": { enabled: true } },
                },
              }),
            );
            expect(capture()).toEqual(before);
          }
          const sharedPath = state.statePath("state", "openclaw.sqlite");
          const sharedStoreId = randomUUID();
          const sharedNamespace = `backup_state_${sharedStoreId.replaceAll("-", "")}`;
          namespaces.add(sharedNamespace);
          {
            using source = openNodeSqliteDatabase(sharedPath, {
              readOnly: true,
              readBigInts: true,
            });
            await materializeDatabasePort({
              source: { engine: "sqlite", db: source },
              destination: { engine: "postgres", db: client, namespace: sharedNamespace },
              descriptor: await statePortProvider.loadDescriptor(),
              storeId: sharedStoreId,
              assertCurrent() {},
            });
          }
          await fs.rename(sharedPath, state.path("source-state.sqlite"));
          {
            using anchor = openNodeSqliteDatabase(sharedPath);
            anchor.exec(
              "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
            );
            anchor
              .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
              .run(sharedStoreId, sharedNamespace);
          }
          // Reverse the mixture: state is PostgreSQL while the plugin remains SQLite.
          const retainedAnchor = state.path("workboard-pg.sqlite");
          await fs.rename(anchorPath, retainedAnchor);
          {
            using local = openNodeSqliteDatabase(anchorPath);
            local.exec(descriptor.sqlite);
          }
          config.database = {
            families: { state: { engine: "postgres" } },
            postgres: { connection },
          };
          await state.writeConfig(config);
          const stateStaging = state.path("state-archive-staging");
          await fs.mkdir(stateStaging);
          const stateResources = await createBackupResourcePlan({
            stateDir: state.stateDir,
            configPaths: [],
            oauthDirs: [],
            workspaceDirs: [],
            excludedWorkspaceDirs: [],
            agentRoots: [],
            pluginResources: inventory.resources,
            pluginRoots: inventory.pluginRoots,
          });
          const statePlan = await createBackupSqliteSnapshotPlan({
            resources: stateResources,
            tempDir: stateStaging,
            legacyAuditSnapshots: [],
          });
          const stateCredentials = statePlan.snapshots.find(
            (asset) => asset.archiveSourcePath === credentialsPath,
          );
          assert(stateCredentials);
          expect(statePlan.inventory.resolveSqliteSource(credentialsPath)?.role).toBe("client");
          expect(readBackupEngine(stateCredentials.sourcePath)).toEqual({ engine: "sqlite" });
          const stateCapsule = statePlan.snapshots.find(
            (asset) => asset.archiveSourcePath === `${sharedPath}.postgres/manifest.json`,
          );
          assert(stateCapsule);
          const workboardImage = statePlan.snapshots.find(
            (asset) => asset.archiveSourcePath === anchorPath,
          );
          assert(workboardImage);
          expect(readBackupEngine(workboardImage.sourcePath)).toEqual({ engine: "sqlite" });
          const stateRestore = await preparePostgresRestore({
            directory: path.dirname(stateCapsule.sourcePath),
            anchorPath: state.path("restored-state.sqlite"),
            config,
            profile: "user-backup",
            assertCurrent() {},
          });
          namespaces.add(stateRestore.namespace);
          expect(stateRestore.namespace).not.toBe(sharedNamespace);
          expect(
            (
              await client.query(
                `SELECT COUNT(*) AS count FROM "${stateRestore.namespace}".config_machine_state`,
              )
            ).rows,
          ).toEqual(
            (
              await client.query(
                `SELECT COUNT(*) AS count FROM "${sharedNamespace}".config_machine_state`,
              )
            ).rows,
          );
          await fs.unlink(anchorPath);
          await fs.rename(retainedAnchor, anchorPath);
          config.database = { engine: "postgres", postgres: { connection } };
          await state.writeConfig(config);
          const homogeneousStaging = state.path("homogeneous-archive-staging");
          await fs.mkdir(homogeneousStaging);
          const homogeneousPlan = await createBackupSqliteSnapshotPlan({
            resources: stateResources,
            tempDir: homogeneousStaging,
            legacyAuditSnapshots: [],
          });
          expect(
            homogeneousPlan.snapshots.some(
              (asset) => asset.archiveSourcePath === `${sharedPath}.postgres/manifest.json`,
            ),
          ).toBe(true);
          const input = {
            backupRoot: state.path("candidate"),
            stateDir: state.stateDir,
            config,
            env: state.env,
            stopped: true,
          };
          // Keep public discovery/wiring; only replace its two subprocess launches.
          const worker = vi.spyOn(inspection, "runUpdateStateInspectionWorker");
          const sizes = vi
            .spyOn(databaseSizes, "readUpdateStateDatabaseSizes")
            .mockImplementation((files, options) =>
              databaseSizes.readUpdateStateDatabaseSizesInProcess(files, options.signal),
            );
          worker.mockImplementation(async (params) => {
            const captured = {
              ...input,
              stagingRoot: params.stagingRoot,
              additionalPaths: z.array(z.string()).parse(params.input.additionalPaths),
            };
            const result =
              params.input.mode === "discover"
                ? await discoverUpdateStateSchemaInspectionInProcess(captured)
                : await createUpdateDatabaseBackupInProcess({
                    ...captured,
                    inspectionPlan: UpdateStateSchemaInspectionPlanSchema.parse(
                      params.input.inspectionPlan,
                    ),
                  });
            return {
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
              stdout: JSON.stringify(result),
              stderr: "",
              inspection: createUpdateStateInspectionDiagnostics({
                operation: "State schema inspection",
                phase: String(params.input.mode),
                paths: captured.additionalPaths,
              }),
            };
          });
          const backup = await createUpdateDatabaseBackup(input).finally(() => {
            worker.mockRestore();
            sizes.mockRestore();
          });
          const entry = backup.databases.find((item) => item.path === anchorPath);
          expect(entry).toMatchObject({ engine: "postgres", namespace, storeId });
          const credentialsBackup = backup.databases.find((item) => item.path === credentialsPath);
          assert(credentialsBackup);
          expect(readBackupEngine(credentialsBackup.snapshotPath)).toEqual({ engine: "sqlite" });
          assert(entry?.exportDirectory);
          await expect(
            verifyMatchedPostgresBackup(entry.exportDirectory, "exact"),
          ).resolves.toMatchObject({ profile: "exact" });
          await client.query(`UPDATE "${namespace}".workboard_cards SET title = 'Migrated'`);
          const displaced = await restoreUpdateDatabaseBackup({
            backup,
            runId: "pg-exact-recovery",
            env: state.env,
            assertCurrent() {},
          });
          expect(displaced).toContain(`PostgreSQL namespace ${namespace}`);
          const restoredShared = readBackupEngine(sharedPath);
          assert(restoredShared.engine === "postgres");
          namespaces.add(restoredShared.namespace);
          const restored = readBackupEngine(anchorPath);
          assert(restored.engine === "postgres");
          namespaces.add(restored.namespace);
          expect(restored.namespace).not.toBe(namespace);
          expect(restored.storeId).toBe(storeId);
          await expectRestored(client, restored.namespace);
          expect(
            (await client.query(`SELECT title FROM "${namespace}".workboard_cards`)).rows,
          ).toEqual([{ title: "Migrated" }]);
          expect(readBackupEngine(`${anchorPath}.migrated-pg-exact-recovery`)).toEqual({
            engine: "postgres",
            namespace,
            storeId,
          });
        }
      } finally {
        await closeOpenClawStateDatabaseAsync();
        for (const owned of namespaces) {
          await client.query(`DROP SCHEMA IF EXISTS "${owned}" CASCADE`);
        }
        await client.end();
      }
    });
  });
});
