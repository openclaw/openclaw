import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { readBackupRunFreshness } from "../state/backup-run-records.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveQuarantineStorePath,
} from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { listArchiveEntries } from "./backup-create.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";

function inspectDatabase(databasePath: string, inspect: (database: DatabaseSync) => void) {
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath, { readOnly: true });
  try {
    inspect(database);
  } finally {
    database.close();
  }
}

type RegisteredAlias = "dot" | "symlink" | "namespace";
const registeredAliases: { includeWorkspace: boolean; alias: RegisteredAlias }[] = [
  { includeWorkspace: false, alias: "dot" },
  { includeWorkspace: true, alias: "symlink" },
];
if (process.platform === "win32") {
  registeredAliases.push({ includeWorkspace: true, alias: "namespace" });
}

describe("backup SQLite ownership", () => {
  it.each(registeredAliases)(
    "backs up registered state inside its workspace ($alias, includeWorkspace=$includeWorkspace)",
    async ({ includeWorkspace, alias }) => {
      await withOpenClawTestState(
        {
          layout: "home",
          prefix: alias === "namespace" ? "backup-namespace-alias-" : "backup-enclosing-workspace-",
          scenario: "minimal",
        },
        async (state) => {
          await state.writeConfig({ agents: { defaults: { workspace: state.home } } });
          const agentPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
          openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
          closeOpenClawAgentDatabasesForTest();
          const aliasPath =
            alias === "dot"
              ? `${state.agentDir()}${path.sep}.${path.sep}openclaw-agent.sqlite`
              : alias === "namespace"
                ? path.toNamespacedPath(agentPath)
                : path.join(state.agentDir(), "z-alias.sqlite");
          if (alias === "symlink") {
            await fs.symlink(agentPath, aliasPath);
          }
          if (alias === "namespace") {
            const stateDb = openOpenClawStateDatabase({ env: state.env });
            stateDb.db
              .prepare("INSERT INTO agent_databases VALUES ('main', ?, ?, ?, ?)")
              .run(aliasPath, OPENCLAW_AGENT_SCHEMA_VERSION, Date.now(), 1);
          } else {
            registerOpenClawAgentDatabase({ agentId: "main", path: aliasPath, env: state.env });
          }
          closeOpenClawStateDatabase();
          const onSqliteSnapshots = vi.fn();
          const runtime = createTestRuntime();
          const archive = await backupCreateCommand(runtime, {
            output: state.path("backup.tar.gz"),
            verify: true,
            ...(alias === "namespace" ? {} : { includeWorkspace, onSqliteSnapshots }),
          });
          expect(archive.verified).toBe(true);
          if (alias !== "namespace") {
            expect(onSqliteSnapshots).toHaveBeenCalledExactlyOnceWith([
              expect.objectContaining({
                role: "global",
                sourcePath: resolveOpenClawStateSqlitePath(state.env),
              }),
              expect.objectContaining({ role: "agent", agentId: "main", sourcePath: agentPath }),
            ]);
          }
          const restoredRoot = state.path("restored");
          await expect(
            backupRestoreCommand(runtime, {
              archive: archive.archivePath,
              target: restoredRoot,
            }),
          ).resolves.toMatchObject({ ok: true });
          if (alias === "namespace") {
            const restoredAgents: string[] = [];
            const visit = async (directory: string) => {
              for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const child = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                  await visit(child);
                } else if (entry.name === "openclaw-agent.sqlite") {
                  restoredAgents.push(child);
                }
              }
            };
            await visit(restoredRoot);
            expect(
              restoredAgents.map((restoredAgent) => restoredAgent.replaceAll("\\", "/")),
            ).toEqual([
              expect.stringContaining(
                `/${buildBackupArchivePath(archive.archiveRoot, agentPath).replaceAll("\\", "/")}`,
              ),
            ]);
            const header = await fs.readFile(restoredAgents[0] ?? "");
            expect(header.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");
          } else {
            const restoredAgent = path.join(
              restoredRoot,
              buildBackupArchivePath(archive.archiveRoot, aliasPath),
            );
            inspectDatabase(restoredAgent, (database) => {
              expect(
                database
                  .prepare("SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'")
                  .get(),
              ).toEqual({ agent_id: "main" });
            });
          }
        },
      );
    },
  );

  it.each(["same path", "agent hardlink", "global hardlink"])(
    "refuses different registered owners sharing a database (%s)",
    async (alias) => {
      await withOpenClawTestState(
        { layout: "home", prefix: "backup-conflicting-owners-", scenario: "minimal" },
        async (state) => {
          await state.writeConfig({ agents: { defaults: { workspace: state.home } } });
          const agentPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
          if (alias === "global hardlink") {
            registerOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
            closeOpenClawStateDatabase();
            await fs.mkdir(state.agentDir(), { recursive: true });
            await fs.link(resolveOpenClawStateSqlitePath(state.env), agentPath);
          } else {
            openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
            closeOpenClawAgentDatabasesForTest();
            const workerPath =
              alias === "same path"
                ? agentPath
                : path.join(state.agentDir("worker"), "openclaw-agent.sqlite");
            if (alias === "agent hardlink") {
              await fs.mkdir(path.dirname(workerPath), { recursive: true });
              await fs.link(agentPath, workerPath);
            }
            registerOpenClawAgentDatabase({ agentId: "worker", path: workerPath, env: state.env });
            closeOpenClawStateDatabase();
          }
          const output = state.path("rejected.tar.gz");
          await expect(
            backupCreateCommand(createTestRuntime(), { output, verify: true }),
          ).rejects.toThrow(/SQLite path aliases multiple core database owners/iu);
          await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a declared plugin database hidden behind a symlink",
    async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "backup-plugin-symlink-", scenario: "minimal" },
        async (state) => {
          const pluginRoot = state.path("backup-plugin");
          await fs.mkdir(pluginRoot);
          const fixture = createColdPluginFixture({
            rootDir: pluginRoot,
            pluginId: "backup-owner",
            manifest: {
              backupResources: [
                { disposition: "include", scope: "state", relativePath: "plugins/linked.sqlite" },
              ],
            },
          });
          await state.writeConfig(createColdPluginConfig(pluginRoot, fixture.pluginId));
          const linkedPath = state.statePath("plugins", "linked.sqlite");
          const backingPath = state.statePath("plugins", "database.bin");
          await fs.mkdir(path.dirname(backingPath));
          const sqlite = requireNodeSqlite();
          const database = new sqlite.DatabaseSync(backingPath);
          try {
            database.function(
              "plugin_double",
              { deterministic: true },
              (value) => Number(value) * 2,
            );
            database.exec(`
            CREATE TABLE records (value INTEGER NOT NULL);
            INSERT INTO records VALUES (7);
            CREATE INDEX records_double ON records(plugin_double(value));
          `);
          } finally {
            database.close();
          }
          await fs.symlink("database.bin", linkedPath);
          const sourceBytes = await fs.readFile(backingPath);
          const output = state.path("rejected.tar.gz");

          await expect(
            backupCreateCommand(createTestRuntime(), { output, includeWorkspace: false }),
          ).rejects.toThrow(/SQLite backup source identity changed.*linked\.sqlite/iu);
          await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readFile(backingPath)).toEqual(sourceBytes);
        },
      );
    },
  );

  it("restores an agent registered immediately before the root snapshot with its registry row", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "backup-late-agent-owner-", scenario: "minimal" },
      async (state) => {
        // This registry snapshot fixture must not inspect another backup's scratch.
        const scratchRoot = state.path("scratch");
        await fs.mkdir(scratchRoot);
        Object.assign(state.envVars, { TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot });
        state.applyEnv();
        const agentPath = state.path("external-agent", "openclaw-agent.sqlite");
        const registration = { agentId: "main", path: agentPath, env: state.env };
        const agent = openOpenClawAgentDatabase(registration);
        agent.db.exec(`
          CREATE TABLE durable_records (value TEXT NOT NULL);
          INSERT INTO durable_records VALUES ('registered-before-root-capture');
        `);
        closeOpenClawAgentDatabasesForTest();
        unregisterOpenClawAgentDatabase(registration);
        closeOpenClawStateDatabase();
        expect(await inspectOpenClawRegisteredAgentDatabases({ env: state.env })).toEqual([]);
        const globalPath = resolveOpenClawStateSqlitePath(state.env);
        const output = state.path("registered-agent.tar.gz");
        const capture = sqliteSnapshot.createVerifiedSqliteSnapshot;
        let registered = false;
        const snapshot = vi
          .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
          .mockImplementation(async (options) => {
            if (!registered && options.sourcePath === globalPath) {
              registerOpenClawAgentDatabase(registration);
              closeOpenClawStateDatabase();
              registered = true;
            }
            return await capture(options);
          });
        try {
          const runtime = createTestRuntime();
          const onSqliteSnapshots = vi.fn();
          const archive = await backupCreateCommand(runtime, {
            output,
            includeWorkspace: false,
            verify: true,
            onSqliteSnapshots,
          });
          expect(onSqliteSnapshots).toHaveBeenCalledExactlyOnceWith([
            expect.objectContaining({ role: "global", sourcePath: globalPath }),
            expect.objectContaining({ role: "agent", agentId: "main", sourcePath: agentPath }),
          ]);
          expect(registered).toBe(true);
          expect(archive.verified).toBe(true);
          expect(archive.warnings ?? []).toEqual([]);
          const restored = await backupRestoreCommand(runtime, {
            archive: archive.archivePath,
            target: state.path("restored"),
          });
          inspectDatabase(
            path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, globalPath)),
            (database) => {
              expect(database.prepare("SELECT agent_id, path FROM agent_databases").all()).toEqual([
                { agent_id: "main", path: agentPath },
              ]);
            },
          );
          inspectDatabase(
            path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, agentPath)),
            (database) => {
              expect(
                database
                  .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
                  .get(),
              ).toEqual({ role: "agent", agent_id: "main" });
              expect(database.prepare("SELECT value FROM durable_records").all()).toEqual([
                { value: "registered-before-root-capture" },
              ]);
            },
          );
          const canonicalAgentPath = await fs.realpath(agentPath);
          inspectDatabase(
            path.join(
              restored.targetPath,
              buildBackupArchivePath(archive.archiveRoot, resolveQuarantineStorePath(state.env)),
            ),
            (database) => {
              expect(
                database.prepare("SELECT path FROM agent_integrity_verifications").all(),
              ).toEqual([{ path: canonicalAgentPath }]);
            },
          );
        } finally {
          snapshot.mockRestore();
        }
      },
    );
  });
});

describe("registered backup hardlinks", () => {
  it.each([
    { role: "agent", aliasName: "a-alias.sqlite", journal: "one WAL" },
    { role: "agent", aliasName: "a-alias.sqlite", journal: "competing WALs" },
    { role: "global", aliasName: "a-alias.sqlite", journal: "one WAL" },
    { role: "global", aliasName: "a-alias.sqlite", journal: "competing WALs" },
  ])(
    "preserves committed rows or refuses unsafe $journal ($role, $aliasName)",
    async ({ role, aliasName, journal }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "backup-registered-hardlinks-", scenario: "minimal" },
        async (state) => {
          const ownerPath =
            role === "global"
              ? resolveOpenClawStateSqlitePath(state.env)
              : path.join(state.agentDir(), "openclaw-agent.sqlite");
          const aliasPath = path.join(path.dirname(ownerPath), aliasName);
          const owner =
            role === "global"
              ? openOpenClawStateDatabase({ env: state.env })
              : openOpenClawAgentDatabase({ agentId: "main", path: ownerPath, env: state.env });
          owner.db.exec("CREATE TABLE durable_records (value TEXT NOT NULL)");
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabase();
          await fs.link(ownerPath, aliasPath);
          if (role === "agent") {
            registerOpenClawAgentDatabase({ agentId: "main", path: aliasPath, env: state.env });
            closeOpenClawStateDatabase();
          }
          const sqlite = requireNodeSqlite();
          const writer = new sqlite.DatabaseSync(ownerPath);
          try {
            writer.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            INSERT INTO durable_records VALUES ('committed-only-in-wal');
          `);
            expect((await fs.stat(`${ownerPath}-wal`)).size).toBeGreaterThan(0);
            await expect(fs.stat(`${aliasPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
            if (journal === "competing WALs") {
              await fs.copyFile(`${ownerPath}-wal`, `${aliasPath}-wal`);
            }
            const output = state.path("backup.tar.gz");
            const runtime = createTestRuntime();
            const create = () =>
              backupCreateCommand(runtime, { output, includeWorkspace: false, verify: true });
            if (journal !== "one WAL") {
              const reason =
                /Ambiguous SQLite hardlink journal ownership: multiple non-empty WAL/iu;
              await expect(create()).rejects.toThrow(reason);
              expect((await readBackupRunFreshness(state.env)).latest).toMatchObject({
                status: "failed",
                error: expect.stringMatching(reason),
              });
              await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
              return;
            }
            const archive = await create();
            expect(archive.verified).toBe(true);
            const restored = await backupRestoreCommand(runtime, {
              archive: archive.archivePath,
              target: state.path("restored"),
            });
            for (const source of [ownerPath, aliasPath]) {
              const database = new sqlite.DatabaseSync(
                path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, source)),
                { readOnly: true },
              );
              try {
                expect(database.prepare("SELECT value FROM durable_records").all()).toEqual([
                  { value: "committed-only-in-wal" },
                ]);
              } finally {
                database.close();
              }
            }
          } finally {
            writer.close();
          }
        },
      );
    },
  );
});

describe.skipIf(process.platform === "win32")("backup SQLite symbolic link loops", () => {
  it("skips an unmanaged loop with one filename warning and restores adjacent files", async () => {
    await withOpenClawTestState(
      { layout: "split", prefix: "backup-opaque-link-", scenario: "minimal" },
      async (state) => {
        // Keep unrelated backup scratch out of this fixture's warning count.
        const scratchRoot = state.path("scratch");
        await fs.mkdir(scratchRoot);
        state.envVars.TMPDIR = scratchRoot;
        state.applyEnv();
        const sideFile = await state.writeText("foreign/keep.txt", "keep this file\n");
        const loopPath = state.statePath("foreign", "cycle.sqlite");
        await fs.symlink("cycle.sqlite", loopPath);
        const runtime = createTestRuntime();
        const archive = await backupCreateCommand(runtime, {
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
          verify: true,
        });

        expect(archive.verified).toBe(true);
        expect(archive.warnings, JSON.stringify(archive.warnings)).toHaveLength(1);
        const warning = expectDefined(archive.warnings?.[0], "skipped link warning");
        expect(warning).toContain("cycle.sqlite");
        expect(warning).toMatch(/skip/iu);
        expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(warning));
        const stateAsset = expectDefined(
          archive.assets.find((asset) => asset.kind === "state"),
          "state asset",
        );
        const archivedDirectory = path.posix.join(stateAsset.archivePath, "foreign");
        const entries = await listArchiveEntries(archive.archivePath);
        expect(entries).not.toContain(`${archivedDirectory}/cycle.sqlite`);
        expect(entries).toContain(`${archivedDirectory}/keep.txt`);

        const restored = await backupRestoreCommand(runtime, {
          archive: archive.archivePath,
          target: state.path("restored"),
        });
        const restoredDirectory = path.join(restored.targetPath, archivedDirectory);
        expect(await fs.readdir(restoredDirectory)).toEqual(["keep.txt"]);
        expect(await fs.readFile(path.join(restoredDirectory, "keep.txt"), "utf8")).toBe(
          "keep this file\n",
        );
        expect(await fs.readlink(loopPath)).toBe("cycle.sqlite");
        expect(await fs.readFile(sideFile, "utf8")).toBe("keep this file\n");
      },
    );
  });

  it.each(["canonical", "declared plugin"] as const)(
    "refuses a %s loop without publishing an archive",
    async (ownership) => {
      await withOpenClawTestState(
        { layout: "split", prefix: "backup-owned-link-", scenario: "minimal" },
        async (state) => {
          if (ownership === "declared plugin") {
            const rootDir = state.path("backup-plugin");
            await fs.mkdir(rootDir);
            const plugin = createColdPluginFixture({
              rootDir,
              pluginId: "backup-owner",
              manifest: {
                backupResources: [
                  { disposition: "include", scope: "state", relativePath: "foreign" },
                ],
              },
            });
            await state.writeConfig(createColdPluginConfig(rootDir, plugin.pluginId));
          }
          const loopPath =
            ownership === "canonical"
              ? resolveOpenClawStateSqlitePath(state.env)
              : state.statePath("foreign", "cycle.sqlite");
          await fs.mkdir(path.dirname(loopPath), { recursive: true });
          await fs.symlink(path.basename(loopPath), loopPath);
          const output = state.path("rejected.tar.gz");

          try {
            await expect(
              backupCreateCommand(createTestRuntime(), {
                output,
                includeWorkspace: false,
                verify: true,
              }),
            ).rejects.toThrow(/ELOOP|too many (?:levels of )?symbolic links/iu);
            await expect(fs.lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await fs.readlink(loopPath)).toBe(path.basename(loopPath));
          } finally {
            await fs.unlink(loopPath);
          }
        },
      );
    },
  );
});
