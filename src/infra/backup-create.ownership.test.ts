import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
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
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  backupCase,
  isolateBackupScratch,
  createVerifiedBackup,
  restoreBackup,
  expectAbsent,
  expectDatabaseRows,
  declarePluginSqliteResources,
  withDatabase,
} from "./backup-create-family.test-support.js";
import { listArchiveEntries } from "./backup-create.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";

function expectSnapshotOwners(callback: unknown, globalPath: string, agentPath: string) {
  expect(callback).toHaveBeenCalledExactlyOnceWith([
    expect.objectContaining({ role: "global", sourcePath: globalPath }),
    expect.objectContaining({ role: "agent", agentId: "main", sourcePath: agentPath }),
  ]);
}

type HardlinkOwner = { role: string; journal: string };

describe("backup SQLite ownership", () => {
  it.each(["dot", "symlink", ...(process.platform === "win32" ? ["namespace"] : [])])(
    "backs up registered %s aliases inside their workspace",
    backupCase({ layout: "home", prefix: "backup-workspace-alias-" })(async (state, alias) => {
      const includeWorkspace = alias !== "dot";
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
      const snapshots = vi.fn();
      const runtime = createTestRuntime();
      const archive = await backupCreateCommand(runtime, {
        output: state.path("backup.tar.gz"),
        verify: true,
        ...(alias === "namespace" ? {} : { includeWorkspace, onSqliteSnapshots: snapshots }),
      });
      expect(archive.verified).toBe(true);
      if (alias !== "namespace") {
        expectSnapshotOwners(snapshots, resolveOpenClawStateSqlitePath(state.env), agentPath);
      }
      const restoredRoot = state.path("restored");
      await expect(restoreBackup(state, archive, runtime)).resolves.toMatchObject({ ok: true });
      if (alias === "namespace") {
        const restoredAgents = (
          await fs.readdir(restoredRoot, { recursive: true, withFileTypes: true })
        )
          .filter((entry) => !entry.isDirectory() && entry.name === "openclaw-agent.sqlite")
          .map((entry) => path.join(entry.parentPath, entry.name));
        const expected = buildBackupArchivePath(archive.archiveRoot, agentPath).replaceAll(
          "\\",
          "/",
        );
        expect(restoredAgents.map((file) => file.replaceAll("\\", "/"))).toEqual([
          expect.stringContaining(`/${expected}`),
        ]);
        const header = await fs.readFile(restoredAgents[0] ?? "");
        expect(header.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");
      } else {
        const restoredAgent = path.join(
          restoredRoot,
          buildBackupArchivePath(archive.archiveRoot, aliasPath),
        );
        expectDatabaseRows(
          restoredAgent,
          "SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'",
          [{ agent_id: "main" }],
        );
      }
    }),
  );

  it.each(["same path", "agent hardlink", "global hardlink"])(
    "refuses different registered owners sharing a database (%s)",
    backupCase({ layout: "home", prefix: "backup-conflicting-owners-" })(async (state, alias) => {
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
      await expectAbsent(output);
    }),
  );

  it.skipIf(process.platform === "win32")(
    "refuses a declared plugin database hidden behind a symlink",
    backupCase({ prefix: "backup-plugin-symlink-" })(async (state) => {
      await declarePluginSqliteResources(state, "plugins/linked.sqlite");
      const linkedPath = state.statePath("plugins", "linked.sqlite");
      const backingPath = state.statePath("plugins", "database.bin");
      await fs.mkdir(path.dirname(backingPath));
      withDatabase(backingPath, (database) => {
        database.function("plugin_double", { deterministic: true }, (value) => Number(value) * 2);
        database.exec(`
            CREATE TABLE records (value INTEGER NOT NULL);
            INSERT INTO records VALUES (7);
            CREATE INDEX records_double ON records(plugin_double(value));
          `);
      });
      await fs.symlink("database.bin", linkedPath);
      const sourceBytes = await fs.readFile(backingPath);
      const output = state.path("rejected.tar.gz");

      await expect(
        backupCreateCommand(createTestRuntime(), { output, includeWorkspace: false }),
      ).rejects.toThrow(/SQLite backup source identity changed.*linked\.sqlite/iu);
      await expectAbsent(output);
      expect(await fs.readFile(backingPath)).toEqual(sourceBytes);
    }),
  );

  it(
    "restores late-registered agents and their registry rows",
    backupCase({ prefix: "backup-late-agent-owner-" })(async (state) => {
      await isolateBackupScratch(state);
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
        const snapshots = vi.fn();
        const archive = await createVerifiedBackup(
          state,
          { onSqliteSnapshots: snapshots },
          runtime,
        );
        expectSnapshotOwners(snapshots, globalPath, agentPath);
        expect(registered).toBe(true);
        expect(archive.verified).toBe(true);
        expect(archive.warnings ?? []).toEqual([]);
        const restored = await restoreBackup(state, archive, runtime);
        const restoredPath = (source: string) =>
          path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, source));
        expectDatabaseRows(restoredPath(globalPath), "SELECT agent_id, path FROM agent_databases", [
          { agent_id: "main", path: agentPath },
        ]);
        expectDatabaseRows(
          restoredPath(agentPath),
          "SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'",
          [{ role: "agent", agent_id: "main" }],
        );
        expectDatabaseRows(restoredPath(agentPath), "SELECT value FROM durable_records", [
          { value: "registered-before-root-capture" },
        ]);
        await expectAbsent(`${restoredPath(agentPath)}.seal`);
      } finally {
        snapshot.mockRestore();
      }
    }),
  );
  it.each([
    { role: "agent", journal: "one WAL" },
    { role: "agent", journal: "competing WALs" },
    { role: "global", journal: "one WAL" },
    { role: "global", journal: "competing WALs" },
  ])(
    "preserves committed rows or refuses unsafe $journal ($role)",
    backupCase({ prefix: "backup-registered-hardlinks-" })(
      async (state, { role, journal }: HardlinkOwner) => {
        const ownerPath =
          role === "global"
            ? resolveOpenClawStateSqlitePath(state.env)
            : path.join(state.agentDir(), "openclaw-agent.sqlite");
        const aliasPath = path.join(path.dirname(ownerPath), "a-alias.sqlite");
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
          await expectAbsent(`${aliasPath}-wal`);
          if (journal === "competing WALs") {
            await fs.copyFile(`${ownerPath}-wal`, `${aliasPath}-wal`);
          }
          const output = state.path("backup.tar.gz");
          const runtime = createTestRuntime();
          const create = () => createVerifiedBackup(state, {}, runtime);
          if (journal !== "one WAL") {
            const reason = /Ambiguous SQLite hardlink journal ownership: multiple non-empty WAL/iu;
            await expect(create()).rejects.toThrow(reason);
            expect((await readBackupRunFreshness(state.env)).latest).toMatchObject({
              status: "failed",
              error: expect.stringMatching(reason),
            });
            await expectAbsent(output);
            return;
          }
          const archive = await create();
          expect(archive.verified).toBe(true);
          const restored = await restoreBackup(state, archive, runtime);
          for (const source of [ownerPath, aliasPath]) {
            expectDatabaseRows(
              path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, source)),
              "SELECT value FROM durable_records",
              [{ value: "committed-only-in-wal" }],
            );
          }
        } finally {
          writer.close();
        }
      },
    ),
  );
});

describe.skipIf(process.platform === "win32")("backup SQLite symbolic link loops", () => {
  it(
    "skips an unmanaged loop with one filename warning and restores adjacent files",
    backupCase({ layout: "split", prefix: "backup-opaque-link-" })(async (state) => {
      await isolateBackupScratch(state);
      const sideFile = await state.writeText("foreign/keep.txt", "keep this file\n");
      const loopPath = state.statePath("foreign", "cycle.sqlite");
      await fs.symlink("cycle.sqlite", loopPath);
      const runtime = createTestRuntime();
      const archive = await createVerifiedBackup(state, {}, runtime);

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

      const restored = await restoreBackup(state, archive, runtime);
      const restoredDirectory = path.join(restored.targetPath, archivedDirectory);
      expect(await fs.readdir(restoredDirectory)).toEqual(["keep.txt"]);
      expect(await fs.readFile(path.join(restoredDirectory, "keep.txt"), "utf8")).toBe(
        "keep this file\n",
      );
      expect(await fs.readlink(loopPath)).toBe("cycle.sqlite");
      expect(await fs.readFile(sideFile, "utf8")).toBe("keep this file\n");
    }),
  );

  it.each(["canonical", "declared plugin"] as const)(
    "refuses a %s loop without publishing an archive",
    backupCase({ layout: "split", prefix: "backup-owned-link-" })(
      async (state, ownership: string) => {
        if (ownership === "declared plugin") {
          await declarePluginSqliteResources(state, "foreign");
        }
        const loopPath =
          ownership === "canonical"
            ? resolveOpenClawStateSqlitePath(state.env)
            : state.statePath("foreign", "cycle.sqlite");
        await fs.mkdir(path.dirname(loopPath), { recursive: true });
        await fs.symlink(path.basename(loopPath), loopPath);
        const output = state.path("rejected.tar.gz");

        try {
          await expect(createVerifiedBackup(state, { output })).rejects.toThrow(
            /ELOOP|too many (?:levels of )?symbolic links/iu,
          );
          await expect(fs.lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readlink(loopPath)).toBe(path.basename(loopPath));
        } finally {
          await fs.unlink(loopPath);
        }
      },
    ),
  );
});
