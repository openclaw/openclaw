import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { transformConfigFile } from "../config/config.js";
import { recordConfigFileWrite } from "../config/write-capture.js";
import * as pluginBackupResources from "../plugins/doctor-contract-registry.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDatabaseLifecycle from "../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import { restorePreparedUpdateRecoveryBackup } from "./update-recovery-backup-restore.js";
import {
  appendUpdateRecoveryConfigWrites,
  createUpdateRecoveryBackup,
  preserveUpdateRecoveryCandidate,
  prepareUpdateRecoveryGeneration,
  restoreUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "./update-recovery-backup.js";
import {
  assertUpdateRecoveryConfigUnchanged,
  persistUpdateRecoveryConfigWrites,
  withUpdateRecoveryConfigWrites,
} from "./update-recovery-config-writes.js";
import { createUpdateRun } from "./update-run-ledger.js";

const authority = { assertOwned() {} };
const execFileAsync = promisify(execFile);
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn<() => string>());
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

async function fixture(state: OpenClawTestState, legacySchema = true) {
  const coordinatorDir = state.path("coordinator");
  await fs.mkdir(coordinatorDir, { mode: 0o700 });
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
  });
  const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
  closeOpenClawStateDatabaseForTest();
  const databasePath = state.statePath("state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE workshop(workspace_dir TEXT);
    INSERT INTO workshop(rowid,workspace_dir) VALUES (9,'original-workspace');
    INSERT INTO delivery_queue_entries(queue_name,id,status,entry_json,enqueued_at,updated_at)
      VALUES ('test','pending-delivery','pending','{}',1,1);
    INSERT INTO state_leases(scope,lease_key,owner,created_at,updated_at)
      VALUES ('test','retained','fixture',1,1);
    INSERT INTO agent_database_leases(lease_id,agent_id,path,owner_pid,opened_at)
      VALUES ('source-agent','main','agents/main/agent/openclaw-agent.sqlite',1,1);
  `);
  if (legacySchema) {
    database.exec(`
      PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version=15, app_version='2026.9.2' WHERE meta_key='primary';
    `);
  }
  await fs.mkdir(state.path("install"), { mode: 0o700 });
  return { database, databasePath, installRoot: state.path("install"), runId: run.runId };
}

describe("update recovery backup", () => {
  it("refuses unclassified post-capture database writes without losing committed WAL data", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { database, installRoot, runId } = await fixture(state);
      try {
        const ref = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
        database.exec(`
          ALTER TABLE workshop RENAME COLUMN workspace_dir TO owner_agent_id;
          PRAGMA user_version = 16;
          UPDATE schema_meta SET schema_version = 16 WHERE meta_key = 'primary';
          INSERT INTO workshop(rowid, owner_agent_id) VALUES (10, 'newer-user-write');
          DELETE FROM delivery_queue_entries WHERE id = 'pending-delivery';
        `);
        expect(
          database.prepare("SELECT owner_agent_id FROM workshop WHERE rowid = 10").get(),
        ).toEqual({ owner_agent_id: "newer-user-write" });
        let refusal: unknown;
        try {
          await restoreUpdateRecoveryBackup(ref, authority);
        } catch (error) {
          refusal = error;
        }
        expect.soft(refusal, "unknown database writes require safe refusal").toBeInstanceOf(Error);
        expect
          .soft(database.prepare("SELECT COUNT(*) AS count FROM workshop WHERE rowid = 10").get())
          .toEqual({ count: 1 });
        expect.soft(database.prepare("SELECT id FROM delivery_queue_entries").all()).toEqual([]);
        expect.soft(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId });
      } finally {
        database.close();
      }
    });
  });

  it("refuses unclassified plugin-directory changes before replacing or pruning user data", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { database, installRoot, runId } = await fixture(state);
      const directory = state.path("plugin-data");
      await fs.mkdir(directory);
      const original = path.join(directory, "records");
      const newer = path.join(directory, "new-user-record");
      await fs.writeFile(original, "captured record\n");
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: directory, kind: "directory" }]);
      try {
        const ref = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
        await fs.writeFile(original, "newer user edit\n");
        await fs.writeFile(newer, "newer user record\n");
        let refusal: unknown;
        try {
          await restoreUpdateRecoveryBackup(ref, authority);
        } catch (error) {
          refusal = error;
        }
        expect
          .soft(refusal, "directory ownership is not per-write migration provenance")
          .toBeInstanceOf(Error);
        expect.soft(await fs.readFile(original, "utf8")).toBe("newer user edit\n");
        expect
          .soft(await fs.readFile(newer, "utf8").catch(() => "MISSING"))
          .toBe("newer user record\n");
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId });
      } finally {
        declaration.mockRestore();
        database.close();
      }
    });
  });

  it("retains both generations when publication fails after one resource was restored", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { database, installRoot, runId } = await fixture(state);
      const directory = state.path("plugin-data");
      await fs.mkdir(directory);
      const first = path.join(directory, "a");
      const second = path.join(directory, "b");
      await fs.writeFile(first, "captured-a\n");
      await fs.writeFile(second, "captured-b\n");
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: directory, kind: "directory" }]);
      try {
        const ref = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
        const firstCandidate = "candidate-generation-first-user-write\n";
        const secondCandidate = "candidate-generation-second-user-write\n";
        await fs.writeFile(first, firstCandidate);
        await fs.writeFile(second, secondCandidate);
        const rename = fs.rename;
        const publicationFailure = vi
          .spyOn(fs, "rename")
          .mockImplementation(async (source, target) => {
            if (target === second) {
              throw Object.assign(new Error("Synthetic second-resource publication failure"), {
                code: "EIO",
              });
            }
            return await rename(source, target);
          });
        try {
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow();
        } finally {
          publicationFailure.mockRestore();
        }
        const files = (
          await fs.readdir(state.root, { recursive: true, withFileTypes: true })
        ).filter((entry) => entry.isFile());
        const contents = await Promise.all(
          files.map((entry) => fs.readFile(path.join(entry.parentPath, entry.name))),
        );
        expect
          .soft(
            contents.some((bytes) => bytes.includes(firstCandidate)),
            "the first candidate resource must survive somewhere, even after partial publication",
          )
          .toBe(true);
        expect.soft(contents.some((bytes) => bytes.includes(secondCandidate))).toBe(true);
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId });
      } finally {
        declaration.mockRestore();
        database.close();
      }
    });
  });

  it("waits for native agent closure before closing shared state or restoring files", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      const sharedPath = state.statePath("state", "openclaw.sqlite");
      const agentPath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      const shared = openOpenClawStateDatabase({ env: state.env, path: sharedPath });
      const original = "original config bytes\n";
      const payloadPath = state.path("verified-config");
      await fs.writeFile(payloadPath, original);
      await fs.writeFile(state.configPath, "current config bytes\n");
      const closing = createDeferredCore();
      const release = createDeferredCore();
      const drain = vi
        .spyOn(agentDatabaseLifecycle, "closeOpenClawAgentDatabasesAsync")
        .mockImplementation(async (pathname) => {
          if (pathname === agentPath) {
            closing.resolve();
            await release.promise;
            // The agent's closing lease still needs the shared connection.
            expect(shared.db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
          }
        });
      const restore = restorePreparedUpdateRecoveryBackup(
        {
          manifest: {
            schemaVersion: 1,
            kind: "update-recovery",
            runId: "native-drain",
            installRoot: state.path("install"),
            stateDir: state.stateDir,
            configPath: state.configPath,
            configPaths: [state.configPath],
            creator: { host: "test-host", pid: 1, startIdentity: "1" },
            drivers: [],
            createdAt: "2026-09-10T00:00:00.000Z",
            roots: [sharedPath, agentPath, state.configPath],
            excludedRoots: [],
            protectedPaths: [sharedPath, agentPath, state.configPath],
            entries: [
              { kind: "missing", sourcePath: sharedPath, sqlite: true, directory: false },
              { kind: "missing", sourcePath: agentPath, sqlite: true, directory: false },
              {
                kind: "file",
                sourcePath: state.configPath,
                archivePath: "payload/0",
                size: Buffer.byteLength(original),
                sha256: createHash("sha256").update(original).digest("hex"),
                sqlite: false,
                mode: 0o600,
              },
            ],
          },
          payloads: new Map([["payload/0", payloadPath]]),
          assertCurrent: async () => {},
        },
        authority,
      );
      try {
        expect(
          await Promise.race([
            closing.promise.then(() => "closing"),
            restore.then(() => "restored"),
          ]),
        ).toBe("closing");
        expect(await fs.readFile(state.configPath, "utf8")).toBe("current config bytes\n");
        expect(shared.db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
        release.resolve();
        await restore;
        expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
        expect(shared.db.isOpen).toBe(false);
      } finally {
        release.resolve();
        await restore;
        drain.mockRestore();
      }
    });
  });

  it.each([
    { cleanupFailure: false, directory: false },
    { cleanupFailure: true, directory: false },
    { cleanupFailure: false, directory: true },
  ])(
    "refuses raw rollback through an old updater's open connection without losing candidate data (cleanup failure=$cleanupFailure, directory=$directory)",
    async ({ cleanupFailure, directory }) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, databasePath, installRoot, runId } = await fixture(state);
        const configBefore = await fs.readFile(state.configPath, "utf8");
        const ordinaryFile = await state.writeText("notes-wal", "ordinary file before update\n");
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const workspaceDatabasePath = path.join(state.workspaceDir, "unrelated.sqlite");
        const workspaceDatabase = new (requireNodeSqlite().DatabaseSync)(workspaceDatabasePath);
        workspaceDatabase.exec("CREATE TABLE unrelated(value TEXT)");
        workspaceDatabase.close();
        const declaration = directory
          ? vi
              .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
              .mockResolvedValue([{ path: path.dirname(databasePath), kind: "directory" }])
          : undefined;
        try {
          const inode = (await fs.stat(databasePath)).ino;
          const ref = await createUpdateRecoveryBackup({
            ...authority,
            installRoot,
            runId,
          });
          const manifest = await verifyUpdateRecoveryBackup(ref);
          expect(manifest.kind).toBe("update-recovery");
          const sharedPayload = manifest.entries.find(
            (entry) => entry.kind === "file" && entry.sourcePath === databasePath,
          );
          if (!sharedPayload || sharedPayload.kind !== "file") {
            throw new Error("Fixture has no shared database payload");
          }
          const captured = new (requireNodeSqlite().DatabaseSync)(
            path.join(ref.directory, sharedPayload.archivePath),
            { readOnly: true },
          );
          try {
            expect(captured.prepare("SELECT lease_key FROM state_leases").all()).toEqual([
              { lease_key: "retained" },
            ]);
            expect(captured.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([
              { lease_id: "source-agent" },
            ]);
          } finally {
            captured.close();
          }
          expect(manifest.entries.some((entry) => entry.sourcePath.startsWith(ref.directory))).toBe(
            false,
          );
          expect(
            manifest.entries.some(
              (entry) =>
                entry.sourcePath === ordinaryFile || entry.sourcePath.endsWith("/unrelated.sqlite"),
            ),
          ).toBe(false);
          database.exec(
            "ALTER TABLE workshop RENAME COLUMN workspace_dir TO owner_agent_id; DELETE FROM delivery_queue_entries; PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16 WHERE meta_key='primary';",
          );
          const nextConfig = '{"gateway":{"mode":"remote"}}\n';
          await withUpdateRecoveryConfigWrites(ref, authority, async () => {
            await fs.writeFile(state.configPath, nextConfig);
            recordConfigFileWrite(
              state.configPath,
              createHash("sha256").update(configBefore).digest("hex"),
              createHash("sha256").update(nextConfig).digest("hex"),
            );
          });
          await fs.writeFile(ordinaryFile, "changed by migration\n");
          const newerNote = await state.writeText("operator-note.md", "written after the backup\n");
          const missingDatabase = manifest.entries.find(
            (entry) =>
              entry.kind === "missing" &&
              entry.sqlite &&
              entry.sourcePath.endsWith("openclaw-agent.sqlite"),
          );
          expect(missingDatabase).toBeDefined();
          if (!missingDatabase) {
            throw new Error("Fixture has no missing agent database");
          }
          await fs.mkdir(path.dirname(missingDatabase.sourcePath), { recursive: true });
          await fs.writeFile(missingDatabase.sourcePath, "new database placeholder");
          await fs.writeFile(`${missingDatabase.sourcePath}-wal`, "new sidecar");
          let cleanupFailed = false;
          const remove = fs.rm;
          const cleanup = cleanupFailure
            ? vi.spyOn(fs, "rm").mockImplementation(async (pathname, options) => {
                if (
                  typeof pathname === "string" &&
                  path.dirname(pathname) === ref.directory &&
                  path.basename(pathname).startsWith(".verify-")
                ) {
                  cleanupFailed = true;
                  throw new Error("Synthetic verification staging cleanup failure");
                }
                await remove(pathname, options);
              })
            : undefined;
          try {
            await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
              /candidate preservation failed|Synthetic verification staging cleanup failure/,
            );
          } finally {
            cleanup?.mockRestore();
          }
          expect(cleanupFailed).toBe(cleanupFailure);
          expect(database.prepare("SELECT rowid,owner_agent_id FROM workshop").get()).toEqual({
            rowid: 9,
            owner_agent_id: "original-workspace",
          });
          expect(database.prepare("SELECT id FROM delivery_queue_entries").all()).toEqual([]);
          expect(database.prepare("SELECT lease_key FROM state_leases").all()).toEqual([
            { lease_key: "retained" },
          ]);
          expect(database.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([
            { lease_id: "source-agent" },
          ]);
          expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
          expect((await fs.stat(databasePath)).ino).toBe(inode);
          expect(await fs.readFile(state.configPath, "utf8")).toBe(nextConfig);
          expect(await fs.readFile(ordinaryFile, "utf8")).toBe("changed by migration\n");
          expect(await fs.readFile(newerNote, "utf8")).toBe("written after the backup\n");
          expect(await fs.readFile(missingDatabase.sourcePath, "utf8")).toBe(
            "new database placeholder",
          );
          expect(await fs.readFile(`${missingDatabase.sourcePath}-wal`, "utf8")).toBe(
            "new sidecar",
          );
          await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({
            runId,
          });
        } finally {
          declaration?.mockRestore();
          database.close();
        }
      });
    },
  );

  it("retains captured plugin leases as evidence without resurrecting deleted plugin records", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { database, databasePath, installRoot, runId } = await fixture(state, false);
      const pluginPath = state.path("plugin.sqlite");
      const plugin = new (requireNodeSqlite().DatabaseSync)(pluginPath);
      plugin.exec(`
        CREATE TABLE state_leases (lease_key TEXT);
        INSERT INTO state_leases VALUES ('plugin-data');
        CREATE TABLE agent_database_leases (lease_id TEXT);
        INSERT INTO agent_database_leases VALUES ('plugin-agent-data');
      `);
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: pluginPath, kind: "sqlite" }]);
      try {
        const ref = await withPluginLifecycleLease({ waitMs: 0 }, async (lease) => {
          const capture = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
          lease.assertOwned();
          return capture;
        });
        const manifest = await verifyUpdateRecoveryBackup(ref);
        const entry = manifest.entries.find(
          (item) => item.kind === "file" && item.sourcePath === databasePath,
        );
        if (!entry || entry.kind !== "file") {
          throw new Error("Fixture has no shared database payload");
        }
        const captured = new (requireNodeSqlite().DatabaseSync)(
          path.join(ref.directory, entry.archivePath),
          { readOnly: true },
        );
        try {
          expect(
            captured
              .prepare("SELECT lease_key FROM state_leases WHERE scope='core:plugin-lifecycle'")
              .all(),
          ).toEqual([{ lease_key: "global" }]);
          expect(captured.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([
            { lease_id: "source-agent" },
          ]);
        } finally {
          captured.close();
        }
        expect(
          database
            .prepare("SELECT lease_key FROM state_leases WHERE scope='core:plugin-lifecycle'")
            .all(),
        ).toEqual([]);
        database.exec("UPDATE workshop SET workspace_dir='migrated'");
        plugin.exec("DELETE FROM state_leases; DELETE FROM agent_database_leases");

        await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
          /no migration-owner reverse contract/,
        );

        await expect(
          withPluginLifecycleLease({ waitMs: 0 }, async (lease) => lease.assertOwned()),
        ).resolves.toBeUndefined();
        expect(database.prepare("SELECT lease_key FROM state_leases").all()).toEqual([
          { lease_key: "retained" },
        ]);
        expect(database.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([
          { lease_id: "source-agent" },
        ]);
        expect(database.prepare("SELECT rowid,workspace_dir FROM workshop").get()).toEqual({
          rowid: 9,
          workspace_dir: "migrated",
        });
        expect(plugin.prepare("SELECT * FROM state_leases").all()).toEqual([]);
        expect(plugin.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toEqual(manifest);
      } finally {
        declaration.mockRestore();
        database.close();
        plugin.close();
      }
    });
  });

  it.each(["changed bytes", "symlink"] as const)(
    "refuses %s in a payload before changing any live file",
    async (damage) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, installRoot, runId } = await fixture(state);
        try {
          const ref = await createUpdateRecoveryBackup({
            ...authority,
            installRoot,
            runId,
          });
          const manifest = await verifyUpdateRecoveryBackup(ref);
          const payload = manifest.entries.find((entry) => entry.kind === "file" && entry.sqlite);
          if (!payload || payload.kind !== "file") {
            throw new Error("Fixture has no SQLite payload");
          }
          const payloadPath = path.join(ref.directory, payload.archivePath);
          if (damage === "changed bytes") {
            await fs.writeFile(payloadPath, "corrupted");
          } else {
            const moved = `${payloadPath}.moved`;
            await fs.rename(payloadPath, moved);
            await fs.symlink(moved, payloadPath);
          }
          await fs.writeFile(state.configPath, "newer config bytes");
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow();
          expect(await fs.readFile(state.configPath, "utf8")).toBe("newer config bytes");
          expect(database.prepare("SELECT rowid FROM workshop").get()).toEqual({ rowid: 9 });
        } finally {
          database.close();
        }
      });
    },
  );

  it.each(["owned repair", "operator value", "operator comment", "parent-child-parent"] as const)(
    "preserves included config byte ownership after %s",
    async (change) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const coordinatorDir = state.path("coordinator");
        await fs.mkdir(coordinatorDir, { mode: 0o700 });
        resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
        const includePath = state.statePath("gateway.json5");
        const original = '{"mode":"local"}\n';
        await fs.writeFile(includePath, original);
        await state.writeConfig({
          agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
          gateway: { $include: "./gateway.json5" },
          plugins: { enabled: false },
        });
        const rootBefore = await fs.readFile(state.configPath, "utf8");
        await fs.mkdir(state.path("install"), { mode: 0o700 });
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          installRoot: state.path("install"),
          runId: run.runId,
        });
        const immutableManifest = await fs.readFile(ref.manifestPath, "utf8");
        let owned = "";
        await withUpdateRecoveryConfigWrites(ref, authority, async () => {
          await transformConfigFile({
            transform: (config) => ({
              nextConfig: { ...config, gateway: { ...config.gateway, port: 19112 } },
            }),
            writeOptions: {
              inputBase: "source",
              skipPluginValidation: true,
              skipRuntimeSnapshotRefresh: true,
            },
          });
          owned = await fs.readFile(includePath, "utf8");
          if (change === "parent-child-parent") {
            await persistUpdateRecoveryConfigWrites(ref, authority);
            const childBytes = owned.replace("19112", "19223");
            expect(childBytes).not.toBe(owned);
            await fs.writeFile(includePath, childBytes);
            // A separate child publishes its receipt without joining the parent's capture Map.
            await appendUpdateRecoveryConfigWrites(
              ref,
              [
                {
                  path: await fs.realpath(includePath),
                  beforeHash: createHash("sha256").update(owned).digest("hex"),
                  afterHash: createHash("sha256").update(childBytes).digest("hex"),
                  contiguous: true,
                },
              ],
              authority,
            );
            await transformConfigFile({
              transform: (config) => ({
                nextConfig: { ...config, gateway: { ...config.gateway, port: 19334 } },
              }),
              writeOptions: {
                inputBase: "source",
                skipPluginValidation: true,
                skipRuntimeSnapshotRefresh: true,
              },
            });
            owned = await fs.readFile(includePath, "utf8");
            expect(owned).toContain("19334");
          }
          await assertUpdateRecoveryConfigUnchanged(ref, authority);
          if (change === "owned repair" || change === "parent-child-parent") {
            await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
              /Rollback publication is unavailable/,
            );
          }
        });
        expect(owned).not.toBe(original);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(rootBefore);
        await writeUpdateRecoveryBackupOutcome(ref, { status: "pending" }, authority);
        if (change === "owned repair" || change === "parent-child-parent") {
          await expect(
            assertUpdateRecoveryConfigUnchanged(ref, authority),
          ).resolves.toBeUndefined();
          const candidate = await preserveUpdateRecoveryCandidate(ref, authority);
          const prepared = await prepareUpdateRecoveryGeneration(ref, candidate, authority);
          const preparedManifest = await verifyUpdateRecoveryBackup(prepared);
          const include = preparedManifest.entries.find(
            (entry) => entry.sourcePath === includePath,
          );
          if (include?.kind !== "file") {
            throw new Error("Prepared generation lost its included config");
          }
          expect(
            await fs.readFile(path.join(prepared.directory, include.archivePath), "utf8"),
          ).toBe(original);
          expect(await fs.readFile(includePath, "utf8")).toBe(owned);
        } else {
          const operatorBytes =
            change === "operator comment"
              ? `${owned}// operator comment\n`
              : owned.replace("19112", "19222");
          await fs.writeFile(includePath, operatorBytes);
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
            /changed outside the recorded update writes/,
          );
          expect(await fs.readFile(includePath, "utf8")).toBe(operatorBytes);
          expect(await fs.readFile(state.configPath, "utf8")).toBe(rootBefore);
        }
        expect(await fs.readFile(ref.manifestPath, "utf8")).toBe(immutableManifest);
      });
    },
  );

  it.each([
    "unchanged",
    "owned replacement",
    "retargeted",
    "parent retargeted",
    "unowned replacement",
  ] as const)("preserves config symlink ownership when %s", async (change) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { database, installRoot, runId } = await fixture(state, false);
      const originalDir = state.path("original-config");
      const alternateDir = state.path("alternate-config");
      const route = state.path("config-route");
      const originalTarget = path.join(originalDir, "openclaw.json");
      const alternateTarget = path.join(alternateDir, "openclaw.json");
      await fs.mkdir(originalDir);
      await fs.mkdir(alternateDir);
      const original = await fs.readFile(state.configPath);
      await fs.rename(state.configPath, originalTarget);
      await fs.symlink(originalDir, route, "junction");
      const originalLink = path.join(route, "openclaw.json");
      await fs.symlink(originalLink, state.configPath);
      try {
        const ref = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
        await fs.writeFile(alternateTarget, original);
        database.exec("UPDATE workshop SET workspace_dir='migrated-workspace'");
        await withUpdateRecoveryConfigWrites(ref, authority, async () => {
          if (change === "parent retargeted") {
            await fs.unlink(route);
            await fs.symlink(alternateDir, route, "junction");
          } else if (change !== "unchanged") {
            await fs.unlink(state.configPath);
            if (change === "retargeted") {
              await fs.symlink(alternateTarget, state.configPath);
            } else {
              const contents =
                change === "owned replacement"
                  ? Buffer.concat([original, Buffer.from("\n")])
                  : original;
              await fs.writeFile(state.configPath, contents);
              if (change === "owned replacement") {
                recordConfigFileWrite(
                  state.configPath,
                  createHash("sha256").update(original).digest("hex"),
                  createHash("sha256").update(contents).digest("hex"),
                );
              }
            }
          }
          const link = await fs.readlink(state.configPath).catch(() => null);
          const routeTarget = await fs.readlink(route);
          if (change === "unchanged" || change === "owned replacement") {
            await restoreUpdateRecoveryBackup(ref, authority);
            expect(await fs.readlink(state.configPath)).toBe(originalLink);
            expect(database.prepare("SELECT workspace_dir FROM workshop").get()).toEqual({
              workspace_dir: "original-workspace",
            });
          } else {
            await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
              /changed outside the recorded update writes/,
            );
            expect(await fs.readlink(state.configPath).catch(() => null)).toBe(link);
            expect(await fs.readlink(route)).toBe(routeTarget);
            expect(database.prepare("SELECT workspace_dir FROM workshop").get()).toEqual({
              workspace_dir: "migrated-workspace",
            });
          }
          expect(await fs.readFile(originalTarget)).toEqual(original);
          expect(await fs.readFile(alternateTarget)).toEqual(original);
        });
      } finally {
        database.close();
      }
    });
  });

  it("does not mistake an operator-created empty config for a missing original", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "empty" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      await fs.mkdir(state.path("install"), { mode: 0o700 });
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        installRoot: state.path("install"),
        runId: run.runId,
      });
      await fs.writeFile(state.configPath, "");
      await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
        /config ownership is unresolved/,
      );
      expect(await fs.readFile(state.configPath, "utf8")).toBe("");
    });
  });

  it.each(["corrupt database", "orphan WAL"] as const)(
    "refuses a declared extensionless SQLite resource with %s before migration",
    async (failure) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, installRoot, runId } = await fixture(state);
        const databasePath = state.path("external-index");
        const artifact = failure === "orphan WAL" ? `${databasePath}-wal` : databasePath;
        await fs.writeFile(artifact, "retained original bytes");
        const declaration = vi
          .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
          .mockResolvedValue([{ path: databasePath, kind: "sqlite" }]);
        try {
          const configBefore = await fs.readFile(state.configPath, "utf8");
          const capture = createUpdateRecoveryBackup({ ...authority, installRoot, runId });
          if (failure === "orphan WAL") {
            await expect(capture).rejects.toThrow(
              `SQLite database has an orphaned sidecar: ${artifact}`,
            );
          } else {
            await expect(capture).rejects.toMatchObject({
              cause: expect.objectContaining({ message: expect.stringContaining(databasePath) }),
            });
          }
          expect(await fs.readFile(artifact, "utf8")).toBe("retained original bytes");
          expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
          expect(database.prepare("SELECT rowid,workspace_dir FROM workshop").get()).toEqual({
            rowid: 9,
            workspace_dir: "original-workspace",
          });
          expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
        } finally {
          declaration.mockRestore();
          database.close();
        }
      });
    },
  );
});

async function runLanceDb(databasePath: string, operation: string): Promise<string> {
  // The plugin owns this dependency; separate processes release native database handles.
  const result = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { connect } from "@lancedb/lancedb";
const connection = await connect(process.argv[1]);
try {
  ${operation}
} finally {
  connection.close();
}`,
      databasePath,
    ],
    { cwd: fileURLToPath(new URL("../../extensions/memory-lancedb", import.meta.url)) },
  );
  return result.stdout.trim();
}

describe("update recovery database directories", () => {
  it("refuses a directory replaced by an outside symlink during candidate capture", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      await state.writeConfig({ plugins: { enabled: false } });
      const databasePath = state.path("database");
      const outsidePath = state.path("outside");
      await fs.mkdir(databasePath);
      await fs.mkdir(outsidePath);
      await fs.writeFile(path.join(databasePath, "original"), "captured data");
      await fs.writeFile(path.join(outsidePath, "original"), "unrelated original");
      await fs.writeFile(path.join(outsidePath, "new"), "unrelated new data");
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: databasePath, kind: "directory" }]);
      try {
        await fs.mkdir(state.path("install"), { mode: 0o700 });
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          installRoot: state.path("install"),
          runId: run.runId,
        });
        await fs.writeFile(path.join(databasePath, "new"), "migration data");
        const readdir = fs.readdir;
        let swapped = false;
        const listing = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          const result = await readdir(...args);
          if (String(args[0]) === databasePath && !swapped) {
            swapped = true;
            await fs.rename(databasePath, state.path("moved-database"));
            await fs.symlink(outsidePath, databasePath, "junction");
          }
          return result;
        });
        try {
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
            /candidate preservation failed/,
          );
          expect(swapped).toBe(true);
          expect(await fs.readFile(path.join(outsidePath, "original"), "utf8")).toBe(
            "unrelated original",
          );
          expect(await fs.readFile(path.join(outsidePath, "new"), "utf8")).toBe(
            "unrelated new data",
          );
        } finally {
          listing.mockRestore();
        }
      } finally {
        declaration.mockRestore();
      }
    });
  });

  it("refuses unowned LanceDB reversal without deleting newer rows, manifests or local files", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      });
      const databasePath = state.path("memory", "lancedb");
      await runLanceDb(
        databasePath,
        `const table = await connection.createTable("memories", [{ id: "original", text: "captured memory" }]);
table.close();`,
      );
      const retainedCapture = path.join(databasePath, "retained-manual-capture");
      await fs.mkdir(retainedCapture, { mode: 0o700 });
      await fs.writeFile(
        path.join(retainedCapture, UPDATE_CAPTURE_PRIVACY_MARKER),
        UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
      );
      const retainedFile = path.join(retainedCapture, "private-state.txt");
      await fs.writeFile(retainedFile, "retained original recovery state");
      const versionsPath = path.join(databasePath, "memories.lance", "_versions");
      const capturedManifests = (await fs.readdir(versionsPath)).toSorted();
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: databasePath, kind: "directory" }]);
      try {
        await fs.mkdir(state.path("install"), { mode: 0o700 });
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          installRoot: state.path("install"),
          runId: run.runId,
        });
        const manifest = await verifyUpdateRecoveryBackup(ref);
        expect(manifest.entries).toContainEqual({
          kind: "directory",
          sourcePath: databasePath,
          mode: (await fs.stat(databasePath)).mode & 0o777,
        });
        expect(
          manifest.entries.some(
            (entry) =>
              entry.sourcePath === retainedCapture ||
              entry.sourcePath.startsWith(`${retainedCapture}${path.sep}`),
          ),
        ).toBe(false);
        await runLanceDb(
          databasePath,
          `const table = await connection.openTable("memories");
try {
  await table.addColumns([{ name: "agentId", valueSql: "'main'" }]);
  await table.add([{ id: "new", text: "migration memory", agentId: "main" }]);
} finally {
  table.close();
}`,
        );
        expect((await fs.readdir(versionsPath)).length).toBeGreaterThan(capturedManifests.length);
        const unrelatedPath = state.path("memory", "operator-note.txt");
        await fs.writeFile(unrelatedPath, "new sibling data");
        const outsidePath = state.path("unrelated-database");
        await fs.mkdir(outsidePath);
        await fs.writeFile(path.join(outsidePath, "keep.txt"), "outside link target");
        await fs.symlink(outsidePath, path.join(databasePath, "new-link"), "junction");
        await fs.mkdir(path.join(databasePath, "new-directory"));
        await fs.writeFile(path.join(databasePath, "new-directory", "new-data"), "migration data");

        const candidateManifests = (await fs.readdir(versionsPath)).toSorted();
        await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
          /no migration-owner reverse contract/,
        );

        const restored = JSON.parse(
          await runLanceDb(
            databasePath,
            `const table = await connection.openTable("memories");
try {
  console.log(JSON.stringify({
    columns: (await table.schema()).fields.map((field) => field.name),
    rows: await table.query().toArray(),
    version: await table.version(),
  }));
} finally {
  table.close();
}`,
          ),
        );
        expect(restored).toEqual({
          columns: ["id", "text", "agentId"],
          rows: [
            { id: "original", text: "captured memory", agentId: "main" },
            { id: "new", text: "migration memory", agentId: "main" },
          ],
          version: 3,
        });
        expect((await fs.readdir(versionsPath)).toSorted()).toEqual(candidateManifests);
        expect(await fs.readFile(retainedFile, "utf8")).toBe("retained original recovery state");
        expect(
          await fs.readFile(path.join(retainedCapture, UPDATE_CAPTURE_PRIVACY_MARKER), "utf8"),
        ).toBe(UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT);
        expect(
          await fs.readFile(path.join(databasePath, "new-directory", "new-data"), "utf8"),
        ).toBe("migration data");
        expect(await fs.readlink(path.join(databasePath, "new-link"))).toBe(outsidePath);
        expect(await fs.readFile(unrelatedPath, "utf8")).toBe("new sibling data");
        expect(await fs.readFile(path.join(outsidePath, "keep.txt"), "utf8")).toBe(
          "outside link target",
        );
      } finally {
        declaration.mockRestore();
      }
    });
  });
});
