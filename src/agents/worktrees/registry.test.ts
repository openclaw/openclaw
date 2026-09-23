import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  clearRegistryWorktreeProvisionedChunks,
  deleteRegistryWorktree,
  getRegistryWorktreeProvisionedChunk,
  findLiveRegistryWorktreeByOwner,
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  insertRegistryWorktreeProvisionedChunk,
  insertRegistryWorktree,
  listLegacyRegistryWorktreesForMigration,
  listRegistryWorktrees,
  listRegistryWorktreesForMigration,
  updateRegistryWorktree,
} from "./registry.js";
import type { ManagedWorktreeRecord } from "./types.js";

function isolatedWorktreeRecord(root: string): ManagedWorktreeRecord {
  return {
    id: "isolated",
    name: "isolated",
    repoFingerprint: "0123456789abcdef",
    repoRoot: path.join(root, "repo"),
    path: path.join(root, "isolated"),
    branch: "openclaw/isolated",
    baseRef: "HEAD",
    ownerKind: "manual",
    createdAt: 10,
    lastActiveAt: 10,
  };
}

describe("managed worktree registry", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-registry-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "ambient"));
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps explicit-state writes independent of a read-only ambient database", () => {
    const ambient = openOpenClawStateDatabase();
    const record = isolatedWorktreeRecord(root);
    const chunk = { worktreeId: record.id, path: "sample.txt", chunkIndex: 0 };
    const bytes = Buffer.from("synthetic snapshot bytes");
    ambient.db.exec("PRAGMA query_only = ON");
    try {
      insertRegistryWorktree(env, record, { provisionedPaths: [chunk.path] });
      expect(getRegistryWorktree(env, record.id)).toEqual(record);
      insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
      expect(Buffer.from(getRegistryWorktreeProvisionedChunk(env, chunk)!)).toEqual(bytes);
      clearRegistryWorktreeProvisionedChunks(env, record.id);
      expect(getRegistryWorktreeProvisionedChunk(env, chunk)).toBeUndefined();
      insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
      updateRegistryWorktree(env, record.id, { lastActiveAt: 20 });
      expect(getRegistryWorktree(env, record.id)?.lastActiveAt).toBe(20);
      deleteRegistryWorktree(env, record.id);
      expect(getRegistryWorktree(env, record.id)).toBeUndefined();
      expect(getRegistryWorktreeProvisionedChunk(env, chunk)).toBeUndefined();
      expect(listRegistryWorktrees(process.env)).toEqual([]);
    } finally {
      ambient.db.exec("PRAGMA query_only = OFF");
    }
  });

  it("rolls back explicit-state snapshot deletion when deleting its worktree fails", () => {
    const record = isolatedWorktreeRecord(root);
    const chunk = { worktreeId: record.id, path: "sample.txt", chunkIndex: 0 };
    const bytes = Buffer.from("preserved snapshot bytes");
    insertRegistryWorktree(env, record, { provisionedPaths: [chunk.path] });
    insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
    const { db } = openOpenClawStateDatabase({ env });
    db.exec(`
      CREATE TEMP TRIGGER registry_delete_fault BEFORE DELETE ON worktrees
      WHEN OLD.id = 'isolated'
      BEGIN SELECT RAISE(ABORT, 'synthetic worktree deletion failure'); END;
    `);

    expect(() => deleteRegistryWorktree(env, record.id)).toThrow(
      "synthetic worktree deletion failure",
    );
    expect(getRegistryWorktree(env, record.id)).toEqual(record);
    expect(Buffer.from(getRegistryWorktreeProvisionedChunk(env, chunk) ?? [])).toEqual(bytes);
  });

  it("inspects absent legacy worktrees without creating the state database", async () => {
    expect(listLegacyRegistryWorktreesForMigration(env)).toEqual([]);
    expect(listRegistryWorktreesForMigration(env)).toEqual([]);
    await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists, orders, updates, and deletes worktree rows through Kysely", () => {
    const record: ManagedWorktreeRecord = {
      id: "first",
      name: "task",
      repoFingerprint: "0123456789abcdef",
      repoRoot: path.join(root, "repo"),
      path: path.join(root, "worktrees", "task"),
      branch: "openclaw/task",
      baseRef: "HEAD",
      ownerKind: "workboard",
      ownerId: "card-1",
      createdAt: 10,
      lastActiveAt: 10,
    };
    insertRegistryWorktree(env, record, { provisionedPaths: [".env.local"] });
    insertRegistryWorktree(env, {
      ...record,
      id: "second",
      name: "task-2",
      path: path.join(root, "worktrees", "task-2"),
      createdAt: 20,
      lastActiveAt: 20,
    });

    expect(listRegistryWorktrees(env).map((entry) => entry.id)).toEqual(["second", "first"]);
    expect(listRegistryWorktreesForMigration(env)).toEqual(listRegistryWorktrees(env));
    expect(listLegacyRegistryWorktreesForMigration(env).map((entry) => entry.id)).toEqual([
      "second",
    ]);
    expect(findLiveRegistryWorktreeByPath(env, record.path)).toMatchObject({
      id: "first",
      ownerKind: "workboard",
      ownerId: "card-1",
    });
    expect(getRegistryWorktreeProvisionedPaths(env, "first")).toEqual([".env.local"]);
    expect(getRegistryWorktreeProvisionedPaths(env, "second")).toBeUndefined();

    updateRegistryWorktree(env, "first", {
      repositoryIdentity: {
        repoRoot: path.join(root, "rebound-repo"),
        repoFingerprint: "fedcba9876543210",
      },
      lastActiveAt: 30,
      removedAt: 40,
      snapshotRef: "refs/openclaw/snapshots/first",
      provisionedState: [{ path: ".env.local", mode: 0o600, chunks: 1 }],
    });
    expect(getRegistryWorktree(env, "first")).toMatchObject({
      repoRoot: path.join(root, "rebound-repo"),
      repoFingerprint: "fedcba9876543210",
      lastActiveAt: 30,
      removedAt: 40,
      snapshotRef: "refs/openclaw/snapshots/first",
    });
    expect(findLiveRegistryWorktreeByPath(env, record.path)).toBeUndefined();
    expect(getRegistryWorktreeProvisionedPaths(env, "first")).toEqual([".env.local"]);
    expect(getRegistryWorktreeProvisionedState(env, "first")).toEqual([
      { path: ".env.local", mode: 0o600, chunks: 1 },
    ]);
    insertRegistryWorktreeProvisionedChunk(env, {
      worktreeId: "first",
      path: ".env.local",
      chunkIndex: 0,
      data: Buffer.from("snapshot"),
    });
    expect(
      Buffer.from(
        getRegistryWorktreeProvisionedChunk(env, {
          worktreeId: "first",
          path: ".env.local",
          chunkIndex: 0,
        })!,
      ).toString(),
    ).toBe("snapshot");

    deleteRegistryWorktree(env, "first");
    expect(getRegistryWorktree(env, "first")).toBeUndefined();
    expect(
      getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: "first",
        path: ".env.local",
        chunkIndex: 0,
      }),
    ).toBeUndefined();

    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET provisioned_paths_json = ? WHERE id = ?")
      .run("not-json", "second");
    expect(getRegistryWorktreeProvisionedPaths(env, "second")).toBeUndefined();
  });

  it("keeps record reads bounded when a worktree has a large provisioning manifest", () => {
    const record: ManagedWorktreeRecord = {
      id: "provisioned",
      name: "provisioned",
      repoFingerprint: "0123456789abcdef",
      repoRoot: path.join(root, "repo"),
      path: path.join(root, "provisioned"),
      branch: "openclaw/provisioned",
      baseRef: "main",
      ownerKind: "session",
      ownerId: "session-1",
      createdAt: 10,
      lastActiveAt: 20,
      snapshotRef: "refs/openclaw/snapshots/provisioned",
      runEndCleanup: { outcome: "retained-provisioned-drift", at: 30 },
    };
    const provisionedPaths = Array.from(
      { length: 1_000 },
      (_, index) => `local/settings/component-${index}.json`,
    );
    insertRegistryWorktree(env, record, { provisionedPaths });
    const counter = trackSqliteStatementExecutions(
      openOpenClawStateDatabase({ env }).db,
      ["records"],
      (sql) => (/\bfrom\s+"worktrees"/iu.test(sql) ? "records" : null),
    );
    try {
      expect(listRegistryWorktrees(env)).toEqual([record]);
      expect(getRegistryWorktree(env, record.id)).toEqual(record);
      expect(findLiveRegistryWorktreeByPath(env, record.path)).toEqual(record);
      expect(findLiveRegistryWorktreeByOwner(env, "session", "session-1")).toEqual(record);
      expect(counter.textBytes.records).toBeLessThan(4_096);
    } finally {
      counter.restore();
    }
    expect(getRegistryWorktreeProvisionedPaths(env, record.id)).toEqual(provisionedPaths);
  });

  it("adds the provisioned-path ledger to an existing worktree registry", () => {
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE worktrees DROP COLUMN provisioned_paths_json;
      DROP INDEX idx_worker_session_placements_environment;
      PRAGMA user_version = 5;
      UPDATE schema_meta SET schema_version = 5 WHERE meta_key = 'primary';
    `);
    legacy.close();

    expect(getRegistryWorktreeProvisionedPaths(env, "missing")).toBeUndefined();
    const database = openOpenClawStateDatabase({ env }).db;
    const columns = database.prepare("PRAGMA table_info(worktrees)").all() as Array<{
      name?: unknown;
    }>;
    expect(columns.some((column) => column.name === "provisioned_paths_json")).toBe(true);
    const chunkTable = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worktree_provisioned_file_chunks'",
      )
      .get();
    expect(chunkTable).toBeTruthy();
  });
});
