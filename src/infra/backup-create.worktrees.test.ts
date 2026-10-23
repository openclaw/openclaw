import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withWorktreeAllocationLease } from "../agents/worktrees/allocation.js";
import { reservePendingWorktree } from "../agents/worktrees/pending-slots.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { makeWorktreeRecord } from "../agents/worktrees/service.test-support.js";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  backupCase,
  createOwnedSqliteDatabase,
  createVerifiedBackup,
  expectAbsent,
  expectDatabaseRows,
  mkdirs,
  restoreBackup,
  withDatabase,
} from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";

const record = (root: string, id: string, worktreePath: string) =>
  makeWorktreeRecord(root, id, {
    path: worktreePath,
    branch: `worktree/${id}`,
    ownerId: `agent:main:${id}`,
  });

describe("backup managed workspaces", () => {
  it.each([1, 17])(
    "backs up pre-Doctor state without rewriting schema %s",
    backupCase({ prefix: "backup-worktree-upgrade-" })(async (state, schemaVersion) => {
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const live = state.statePath("checkouts", "live");
      const removed = state.statePath("checkouts", "removed");
      await mkdirs(path.dirname(databasePath), live, removed);
      await fs.writeFile(path.join(live, "source.txt"), "live checkout\n");
      await fs.writeFile(path.join(removed, "source.txt"), "reused path\n");
      createOwnedSqliteDatabase({ sqlitePath: databasePath, role: "global", schemaVersion });
      withDatabase(databasePath, (database) => {
        // Discovery needs only scope and live paths, not the newer full worktree record.
        database.exec(`CREATE TABLE state_leases (
          scope TEXT NOT NULL
        )`);
        if (schemaVersion === 17) {
          database.exec(`CREATE TABLE worktrees (
            path TEXT NOT NULL, removed_at INTEGER
          ) STRICT`);
          for (const [root, removedAt] of [
            [live, null],
            [removed, 2],
          ] as const) {
            database
              .prepare("INSERT INTO worktrees (path, removed_at) VALUES (?, ?)")
              .run(root, removedAt);
          }
        }
      });
      const original = await fs.readFile(databasePath);
      // Capture is read-only; the CLI separately records its outcome in the live store.
      const archive = await createBackupArchive({
        output: state.path("backup.tar.gz"),
        includeWorkspace: false,
      });
      expect(await verifyBackupArchive(archive.archivePath)).toMatchObject({ ok: true });
      const restored = await restoreBackup(state, archive);
      const restoredPath = (source: string) =>
        path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, source));
      const readRestored = (source: string) => fs.readFile(restoredPath(source), "utf8");
      if (schemaVersion === 17) {
        await expectAbsent(restoredPath(path.join(live, "source.txt")));
      } else {
        await expect(readRestored(path.join(live, "source.txt"))).resolves.toBe("live checkout\n");
      }
      await expect(readRestored(path.join(removed, "source.txt"))).resolves.toBe("reused path\n");
      expectDatabaseRows(restoredPath(databasePath), "PRAGMA user_version", [
        { user_version: schemaVersion },
      ]);
      expect((await fs.readFile(databasePath)).equals(original)).toBe(true);
    }),
  );

  it(
    "omits registered old and custom roots while restoring nested owners and reused retired paths",
    backupCase({ layout: "home", prefix: "backup-managed-worktrees-" })(async (state) => {
      const oldRoot = state.statePath("worktrees", "old-root-chat");
      const customRoot = state.statePath("custom-checkouts", "current-chat");
      const pendingRoot = state.statePath("worktrees", "pending-chat");
      const retiredRoot = state.statePath("worktrees", "reused-path");
      const protectedAgent = path.join(oldRoot, "durable-agent");
      const credentials = path.join(oldRoot, "credentials");
      const includePath = path.join(oldRoot, "settings.json");
      await mkdirs(protectedAgent, credentials);
      await fs.writeFile(includePath, JSON.stringify({ identity: { name: "Kept" } }));
      await fs.writeFile(path.join(credentials, "credential.txt"), "synthetic credential\n");
      Object.assign(state.envVars, {
        OPENCLAW_INCLUDE_ROOTS: oldRoot,
        OPENCLAW_OAUTH_DIR: credentials,
      });
      state.applyEnv();
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: { main: { agentDir: protectedAgent, $include: includePath } },
        },
        worktreeRoot: state.statePath("custom-checkouts"),
      });
      const agentPath = path.join(protectedAgent, "openclaw-agent.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
      for (const [id, root] of [
        ["old", oldRoot],
        ["custom", customRoot],
        ["retired", retiredRoot],
      ] as const) {
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, "build-output.bin"), "workspace bytes\n");
        await insertRegistryWorktree(state.env, {
          ...record(state.root, id, root),
          ...(id === "retired" ? { removedAt: 2 } : {}),
        });
      }
      const pending = record(state.root, "pending", pendingRoot);
      await withWorktreeAllocationLease({ env: state.env, id: pending.id }, async (guard) => {
        await reservePendingWorktree(state.env, pending, guard.workerAuthority);
        await fs.mkdir(pendingRoot, { recursive: true });
        await fs.writeFile(path.join(pendingRoot, "build-output.bin"), "pending bytes\n");
      });
      const adjacent = await state.writeText("worktrees/operator-notes.txt", "keep notes\n");
      await closeStateDatabaseForTest();

      const archive = await createVerifiedBackup(state);
      expect(archive.verified).toBe(true);
      const restored = await restoreBackup(state, archive);
      const restoredPath = (source: string) =>
        path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, source));
      const readRestored = (source: string) => fs.readFile(restoredPath(source), "utf8");
      for (const root of [oldRoot, customRoot, pendingRoot]) {
        await expectAbsent(restoredPath(path.join(root, "build-output.bin")));
        expect(await fs.readFile(path.join(root, "build-output.bin"), "utf8")).toMatch(/bytes/);
      }
      for (const [file, contents] of [
        [path.join(retiredRoot, "build-output.bin"), "workspace bytes\n"],
        [adjacent, "keep notes\n"],
        [includePath, JSON.stringify({ identity: { name: "Kept" } })],
        [path.join(credentials, "credential.txt"), "synthetic credential\n"],
      ] as const) {
        await expect(readRestored(file)).resolves.toBe(contents);
      }
      expectDatabaseRows(
        restoredPath(agentPath),
        "SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'",
        [{ role: "agent", agent_id: "main" }],
      );
    }),
  );

  it.each([false, true])(
    "keeps the existing full-backup selection and resolves registered aliases (includeWorkspace=%s)",
    backupCase({ prefix: "backup-worktree-alias-" })(async (state, includeWorkspace) => {
      const root = state.statePath("worktrees", "chat");
      const alias = state.statePath("chat-alias");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "source.txt"), "managed source\n");
      await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
      await insertRegistryWorktree(state.env, record(state.root, "aliased", alias));
      await closeStateDatabaseForTest();
      const archive = await createVerifiedBackup(state, { includeWorkspace });
      const entries = await listArchiveEntries(archive.archivePath);
      for (const source of [path.join(root, "source.txt"), alias]) {
        expect(entries.includes(buildBackupArchivePath(archive.archiveRoot, source))).toBe(
          includeWorkspace,
        );
      }
    }),
  );
});
