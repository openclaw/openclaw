import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withWorktreeAllocationLease } from "../agents/worktrees/allocation.js";
import { reservePendingWorktree } from "../agents/worktrees/pending-slots.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
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
  restoreBackup,
  withDatabase,
} from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";

function record(root: string, id: string, worktreePath: string): ManagedWorktreeRecord {
  return {
    id,
    name: id,
    repoRoot: root,
    repoFingerprint: "0123456789abcdef",
    path: worktreePath,
    branch: `worktree/${id}`,
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: `agent:main:${id}`,
    createdAt: 1,
    lastActiveAt: 1,
  };
}

describe("backup managed workspaces", () => {
  it.each([1, 17])(
    "backs up pre-Doctor state without rewriting schema %s",
    backupCase({ prefix: "backup-worktree-upgrade-" })(async (state, schemaVersion) => {
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const live = state.statePath("checkouts", "live");
      const removed = state.statePath("checkouts", "removed");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.mkdir(live, { recursive: true });
      await fs.mkdir(removed, { recursive: true });
      await fs.writeFile(path.join(live, "source.txt"), "live checkout\n");
      await fs.writeFile(path.join(removed, "source.txt"), "reused path\n");
      createOwnedSqliteDatabase({ sqlitePath: databasePath, role: "global", schemaVersion });
      withDatabase(databasePath, (database) => {
        // v2026.6.11 has state_leases but no worktrees; v2026.9.4 lacks gc_protection_json.
        database.exec(`CREATE TABLE state_leases (
          scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL,
          expires_at INTEGER, heartbeat_at INTEGER, payload_json TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, lease_key)
        )`);
        if (schemaVersion === 17) {
          database.exec(`CREATE TABLE worktrees (
            id TEXT NOT NULL PRIMARY KEY, repo_fingerprint TEXT NOT NULL, repo_root TEXT NOT NULL,
            path TEXT NOT NULL, branch TEXT NOT NULL, base_ref TEXT NOT NULL,
            owner_kind TEXT NOT NULL CHECK (owner_kind IN ('manual', 'workboard', 'session')),
            owner_id TEXT, snapshot_ref TEXT, provisioned_paths_json TEXT,
            created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, removed_at INTEGER,
            run_end_cleanup_json TEXT
          ) STRICT`);
          for (const [id, root, removedAt] of [
            ["live", live, null],
            ["removed", removed, 2],
          ] as const) {
            database
              .prepare(`INSERT INTO worktrees
              (id, repo_fingerprint, repo_root, path, branch, base_ref, owner_kind,
               created_at, last_active_at, removed_at)
              VALUES (?, '0123456789abcdef', ?, ?, 'main', 'HEAD', 'manual', 1, 1, ?)`)
              .run(id, state.root, root, removedAt);
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
      if (schemaVersion === 17) {
        await expectAbsent(restoredPath(path.join(live, "source.txt")));
      } else {
        expect(await fs.readFile(restoredPath(path.join(live, "source.txt")), "utf8")).toBe(
          "live checkout\n",
        );
      }
      expect(await fs.readFile(restoredPath(path.join(removed, "source.txt")), "utf8")).toBe(
        "reused path\n",
      );
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
      await fs.mkdir(protectedAgent, { recursive: true });
      await fs.mkdir(credentials, { recursive: true });
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
      for (const root of [oldRoot, customRoot, pendingRoot]) {
        await expectAbsent(restoredPath(path.join(root, "build-output.bin")));
        expect(await fs.readFile(path.join(root, "build-output.bin"), "utf8")).toMatch(/bytes/);
      }
      expect(
        await fs.readFile(restoredPath(path.join(retiredRoot, "build-output.bin")), "utf8"),
      ).toBe("workspace bytes\n");
      expect(await fs.readFile(restoredPath(adjacent), "utf8")).toBe("keep notes\n");
      expect(await fs.readFile(restoredPath(includePath), "utf8")).toBe(
        JSON.stringify({ identity: { name: "Kept" } }),
      );
      expect(
        await fs.readFile(restoredPath(path.join(credentials, "credential.txt")), "utf8"),
      ).toBe("synthetic credential\n");
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
      const sourceEntry = buildBackupArchivePath(
        archive.archiveRoot,
        path.join(root, "source.txt"),
      );
      expect(entries.includes(sourceEntry)).toBe(includeWorkspace);
      expect(entries.includes(buildBackupArchivePath(archive.archiveRoot, alias))).toBe(
        includeWorkspace,
      );
    }),
  );
});
