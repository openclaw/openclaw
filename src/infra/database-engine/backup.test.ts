import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { expect, it, vi } from "vitest";
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
import { pluginBackupPlanInput } from "../backup-resource-plan.test-support.js";
import { createBackupSqliteSnapshotPlan } from "../backup-sqlite-snapshot.js";
import { resolveClientCredentialStorePath } from "../client-credential-paths.js";
import { readClientCredentialReceipt } from "../client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "../client-credential-receipt.js";
import {
  capturePortClientCredentialBinding,
  rebindPortedClientCredentials,
} from "../client-credential-restore.js";
import { openClientCredentialCustody } from "../client-credential-store.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import * as snapshotSource from "../sqlite-snapshot-source.js";
import { restoreUpdateDatabaseBackup } from "../update-database-restore.js";
import { createUpdateRun } from "../update-run-ledger.js";
import { createUpdateDatabaseBackupWithFixtureTransport } from "./backup-capture.test-support.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { withDatabaseEngineSelection } from "./context.js";
import { workboardPortFixture, writePortAnchor } from "./port-backup.test-support.js";
import { loadDatabasePortDescriptor } from "./port-provider-descriptor.js";
import { materializeDatabasePort } from "./port.worker.js";
import { statePortProvider } from "./state-port.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const canonicalText = ' {"first":1,"first":2,"escaped":"\\u0000"} \n';
const queryRows = async (client: Client, sql: string) => (await client.query(sql)).rows;

async function expectRestored(client: Client, namespace: string) {
  const rows = (sql: string) => queryRows(client, sql);
  expect(
    await rows(`SELECT title, automation_json, created_at FROM "${namespace}".workboard_cards`),
  ).toEqual([
    { title: "Retained 🦞", automation_json: canonicalText, created_at: "9007199254740993" },
  ]);
  expect(await rows(`SELECT sequence FROM "${namespace}".workboard_card_notifications`)).toEqual([
    { sequence: "9007199254740995" },
  ]);
  expect(await rows(`SELECT content FROM "${namespace}".workboard_attachment_blobs`)).toEqual([
    { content: Buffer.from([0, 255, 128, 1]) },
  ]);
}

it.skipIf(!connection)(
  "restores user and Git exports and exact updater state while preserving source data and sidecars",
  async () => {
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
      const restore = (directory: string, target: string, selected = config) =>
        preparePostgresRestore({
          directory,
          anchorPath: target,
          config: selected,
          profile: "user-backup",
          assertCurrent() {},
        });
      const verifyRestored = async (restored: { namespace: string }) => {
        namespaces.add(restored.namespace);
        expect(restored.namespace).not.toBe(namespace);
        await expectRestored(client, restored.namespace);
      };
      const row = (file: string, sql: string) => {
        using db = openNodeSqliteDatabase(file, { readOnly: true });
        return db.prepare(sql).get();
      };
      await state.writeConfig(config);
      await fs.mkdir(path.dirname(anchorPath), { recursive: true });
      await client.connect();
      try {
        const { descriptor } = await workboardPortFixture();
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
        writePortAnchor(anchorPath, storeId, namespace, true);
        openOpenClawStateDatabase({ env: state.env });
        await closeOpenClawStateDatabaseAsync();
        const credentialsPath = resolveClientCredentialStorePath(state.env);
        {
          using credentials = openClientCredentialCustody(state.env, { createIfMissing: true });
          assert(credentials);
          credentials.database
            .prepare("INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?)")
            .run("synthetic-device", "operator", "synthetic-token", "[]", 1);
          credentials.database
            .prepare("INSERT INTO native_exec_socket_credentials VALUES (?, ?, ?, ?)")
            .run("current", "/synthetic/native.sock", "synthetic-socket-token", 1);
        }
        const inventory = resolveActivatedPluginBackupInventory({
          config,
          env: state.env,
          stateDir: state.stateDir,
        });
        const resources = () =>
          createBackupResourcePlan(pluginBackupPlanInput(state.stateDir, inventory));
        const snapshotPlan = async (name: string, selected = resources()) => {
          const selectedResources = await selected;
          const tempDir = state.path(name);
          await fs.mkdir(tempDir);
          return createBackupSqliteSnapshotPlan({
            resources: selectedResources,
            tempDir,
            legacyAuditSnapshots: [],
          });
        };
        const assetPath = (plan: Awaited<ReturnType<typeof snapshotPlan>>, archivePath: string) => {
          const found = plan.snapshots.find((item) => item.archiveSourcePath === archivePath);
          assert(found);
          return found.sourcePath;
        };
        {
          const originalAnchor = await fs.readFile(anchorPath);
          const plan = await snapshotPlan("archive-staging");
          expect(plan.inventory.resolveSqliteSource(credentialsPath)?.role).toBe("client");
          const credentialsAsset = assetPath(plan, credentialsPath);
          expect(readBackupEngine(credentialsAsset)).toEqual({ engine: "sqlite" });
          expect(
            plan.snapshots.some((asset) =>
              asset.archiveSourcePath.startsWith(`${credentialsPath}.postgres/`),
            ),
          ).toBe(false);
          expect(row(credentialsAsset, "SELECT token FROM device_auth_tokens")).toEqual({
            token: "synthetic-token",
          });
          const socketSql = "SELECT socket_token FROM native_exec_socket_credentials";
          expect(row(credentialsAsset, socketSql)).toEqual({ socket_token: null });
          expect(row(credentialsPath, socketSql)).toEqual({
            socket_token: "synthetic-socket-token",
          });
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
          const restored = await restore(directory, restoredAnchor);
          await verifyRestored(restored);
          expect(readBackupEngine(restoredAnchor)).toEqual({
            engine: "postgres",
            namespace: restored.namespace,
            storeId,
          });
          await expectRestored(client, namespace);
          {
            using wrong = openNodeSqliteDatabase(path.join(directory, "anchor.sqlite"));
            wrong.prepare("UPDATE openclaw_engine_anchor SET store_id = ?").run(randomUUID());
          }
          await expect(verifyMatchedPostgresBackup(directory, "user-backup")).rejects.toThrow();
        }
        {
          const capturedSelection = await resolveDatabaseEngineSelection(config);
          const unavailableConnection = {
            source: "env" as const,
            provider: "default",
            id: `OPENCLAW_UNAVAILABLE_BACKUP_${randomUUID().replaceAll("-", "").toUpperCase()}`,
          };
          const unavailableConfig: OpenClawConfig = {
            ...config,
            database: {
              ...config.database,
              postgres: { connection: unavailableConnection },
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
            const restored = await restore(
              directory,
              state.path("captured-selection-restored.sqlite"),
              unavailableConfig,
            );
            await verifyRestored(restored);
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
          await verifyRestored(gitAnchor);
          expect(gitAnchor.storeId).toBe(storeId);
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
            const root = fileURLToPath(
              new URL("../../../extensions/team-reports", import.meta.url),
            );
            await withPluginCache(createPluginCache(), () =>
              loadDatabasePortDescriptor("team-reports", {
                plugins: {
                  load: { paths: [root] },
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
          const sharedFile = readClientCredentialFileIdentity(sharedPath);
          assert(sharedFile);
          const credentialBinding = capturePortClientCredentialBinding({
            env: state.env,
            sourcePath: sharedPath,
            sourceFile: sharedFile,
          });
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
          writePortAnchor(sharedPath, sharedStoreId, sharedNamespace);
          rebindPortedClientCredentials({
            env: state.env,
            binding: credentialBinding,
            sharedPath,
            sqliteSnapshotPath: state.path("source-state.sqlite"),
            engine: "postgres",
            storeId: sharedStoreId,
            assertCurrent() {},
          });
          {
            using credentials = openClientCredentialCustody(state.env);
            assert(credentials);
            expect(readClientCredentialReceipt(credentials.database)).toMatchObject({
              phase: "complete",
              receipt: {
                source: { kind: "canonical", engine: "postgres", identity: sharedStoreId },
                sharedFile: readClientCredentialFileIdentity(sharedPath),
              },
            });
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
          const stateResources = resources();
          const statePlan = await snapshotPlan("state-archive-staging", stateResources);
          expect(statePlan.inventory.resolveSqliteSource(credentialsPath)?.role).toBe("client");
          expect(readBackupEngine(assetPath(statePlan, credentialsPath))).toEqual({
            engine: "sqlite",
          });
          const stateCapsule = assetPath(statePlan, `${sharedPath}.postgres/manifest.json`);
          expect(readBackupEngine(assetPath(statePlan, anchorPath))).toEqual({ engine: "sqlite" });
          const stateRestore = await restore(
            path.dirname(stateCapsule),
            state.path("restored-state.sqlite"),
          );
          namespaces.add(stateRestore.namespace);
          expect(stateRestore.namespace).not.toBe(sharedNamespace);
          const stateRows = (ns: string) =>
            queryRows(client, `SELECT COUNT(*) AS count FROM "${ns}".config_machine_state`);
          expect(await stateRows(stateRestore.namespace)).toEqual(await stateRows(sharedNamespace));
          await fs.unlink(anchorPath);
          await fs.rename(retainedAnchor, anchorPath);
          config.database = { engine: "postgres", postgres: { connection } };
          await state.writeConfig(config);
          const homogeneousPlan = await snapshotPlan("homogeneous-archive-staging", stateResources);
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
          const backup = await createUpdateDatabaseBackupWithFixtureTransport(input);
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
          await verifyRestored(restored);
          expect(restored.storeId).toBe(storeId);
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
  },
);
