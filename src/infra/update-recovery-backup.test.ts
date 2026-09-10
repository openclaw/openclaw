import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { transformConfigFile } from "../config/config.js";
import { recordConfigFileWrite } from "../config/write-capture.js";
import * as pluginBackupResources from "../plugins/doctor-contract-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDatabaseLifecycle from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { restorePreparedUpdateRecoveryBackup } from "./update-recovery-backup-restore.js";
import {
  appendUpdateRecoveryConfigWrites,
  createUpdateRecoveryBackup,
  findPendingUpdateRecoveryBackup,
  restoreUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "./update-recovery-backup.js";
import {
  assertUpdateRecoveryConfigUnchanged,
  persistUpdateRecoveryConfigWrites,
  withUpdateRecoveryConfigWrites,
} from "./update-recovery-config-writes.js";

const authority = { assertOwned() {} };
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn<() => string>());
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

async function fixture(state: OpenClawTestState) {
  const coordinatorDir = state.path("coordinator");
  await fs.mkdir(coordinatorDir, { mode: 0o700 });
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
  });
  const databasePath = state.statePath("state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    PRAGMA user_version = 15;
    CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT, app_version TEXT, created_at INTEGER, updated_at INTEGER);
    INSERT INTO schema_meta VALUES ('primary','global',15,NULL,'2026.9.2',1,1);
    CREATE TABLE workshop(workspace_dir TEXT);
    INSERT INTO workshop(rowid,workspace_dir) VALUES (9,'original-workspace');
    CREATE TABLE delivery_queue_entries(id TEXT PRIMARY KEY);
    INSERT INTO delivery_queue_entries VALUES ('pending-delivery');
    CREATE TABLE state_leases(scope TEXT,lease_key TEXT);
    INSERT INTO state_leases VALUES ('test','retained');
  `);
  return { database, databasePath, installRoot: state.path("install") };
}

describe("update recovery backup", () => {
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
    "restores the original WAL schema and rows through an old updater's open connection (cleanup failure=$cleanupFailure, directory=$directory)",
    async ({ cleanupFailure, directory }) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, databasePath, installRoot } = await fixture(state);
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
            runId: "restore-open-driver",
          });
          const manifest = await verifyUpdateRecoveryBackup(ref);
          expect(manifest.kind).toBe("update-recovery");
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
            "ALTER TABLE workshop RENAME COLUMN workspace_dir TO owner_agent_id; DELETE FROM delivery_queue_entries; PRAGMA user_version=16;",
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
            await restoreUpdateRecoveryBackup(ref, authority);
          } finally {
            cleanup?.mockRestore();
          }
          expect(cleanupFailed).toBe(cleanupFailure);
          expect(database.prepare("SELECT rowid,workspace_dir FROM workshop").get()).toEqual({
            rowid: 9,
            workspace_dir: "original-workspace",
          });
          expect(database.prepare("SELECT id FROM delivery_queue_entries").all()).toEqual([
            { id: "pending-delivery" },
          ]);
          expect(database.prepare("SELECT lease_key FROM state_leases").all()).toEqual([
            { lease_key: "retained" },
          ]);
          expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
          expect((await fs.stat(databasePath)).ino).toBe(inode);
          expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
          expect(await fs.readFile(ordinaryFile, "utf8")).toBe("changed by migration\n");
          expect(await fs.readFile(newerNote, "utf8")).toBe("written after the backup\n");
          await expect(fs.lstat(missingDatabase.sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(fs.lstat(`${missingDatabase.sourcePath}-wal`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({
            runId: "restore-open-driver",
          });
        } finally {
          declaration?.mockRestore();
          database.close();
        }
      });
    },
  );

  it.each(["changed bytes", "symlink"] as const)(
    "refuses %s in a payload before changing any live file",
    async (damage) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, installRoot } = await fixture(state);
        try {
          const ref = await createUpdateRecoveryBackup({
            ...authority,
            installRoot,
            runId: "corrupt",
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
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          installRoot: state.path("install"),
          runId: "include-ownership",
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
            await restoreUpdateRecoveryBackup(ref, authority);
          }
        });
        expect(owned).not.toBe(original);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(rootBefore);
        await writeUpdateRecoveryBackupOutcome(ref, { status: "pending" }, authority);
        if (change === "owned repair") {
          // Receipt publication can fail after restoration, leaving the Doctor after-image.
          await appendUpdateRecoveryConfigWrites(
            ref,
            [
              {
                path: await fs.realpath(includePath),
                beforeHash: createHash("sha256").update(original).digest("hex"),
                afterHash: createHash("sha256").update(owned).digest("hex"),
                contiguous: true,
              },
            ],
            authority,
          );
          await expect(
            assertUpdateRecoveryConfigUnchanged(ref, authority),
          ).resolves.toBeUndefined();
          await restoreUpdateRecoveryBackup(ref, authority);
          expect(await fs.readFile(includePath, "utf8")).toBe(original);
        } else if (change === "parent-child-parent") {
          expect(await fs.readFile(includePath, "utf8")).toBe(original);
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

  it("does not mistake an operator-created empty config for a missing original", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "empty" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        installRoot: state.path("install"),
        runId: "missing-config",
      });
      await fs.writeFile(state.configPath, "");
      await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
        /changed outside the recorded update writes/,
      );
      expect(await fs.readFile(state.configPath, "utf8")).toBe("");
    });
  });

  it("retains the newest three completed sets and keeps their outcome out of the restored database", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { database, installRoot } = await fixture(state);
      try {
        const refs = [];
        for (let index = 0; index < 4; index++) {
          const ref = await createUpdateRecoveryBackup({
            ...authority,
            installRoot,
            runId: `retention-${index}`,
          });
          refs.push(ref);
          await writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority);
        }
        await expect(fs.lstat(refs[0]!.directory)).rejects.toMatchObject({ code: "ENOENT" });
        for (const ref of refs.slice(1)) {
          await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({
            kind: "update-recovery",
          });
        }
        expect(await findPendingUpdateRecoveryBackup()).toBeNull();
        await writeUpdateRecoveryBackupOutcome(
          refs[3]!,
          {
            status: "restore-failed",
            error: "synthetic restore failure",
          },
          authority,
        );
        await expect(findPendingUpdateRecoveryBackup()).rejects.toThrow(
          "no matching update run exists",
        );
      } finally {
        database.close();
      }
    });
  });

  it.each(["corrupt database", "orphan WAL"] as const)(
    "refuses a declared extensionless SQLite resource with %s before migration",
    async (failure) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, installRoot } = await fixture(state);
        const databasePath = state.path("external-index");
        const artifact = failure === "orphan WAL" ? `${databasePath}-wal` : databasePath;
        await fs.writeFile(artifact, "retained original bytes");
        const declaration = vi
          .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
          .mockResolvedValue([{ path: databasePath, kind: "sqlite" }]);
        try {
          await expect(
            createUpdateRecoveryBackup({ ...authority, installRoot, runId: "invalid-database" }),
          ).rejects.toMatchObject({
            cause: expect.objectContaining({ message: expect.stringContaining("external-index") }),
          });
          expect(await fs.readFile(artifact, "utf8")).toBe("retained original bytes");
        } finally {
          declaration.mockRestore();
          database.close();
        }
      });
    },
  );
});
