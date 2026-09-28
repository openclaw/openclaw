import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { readLiveRegistryWorktreeIds, readRegistryWorktrees } from "./registry-read.js";
import {
  getRegistryWorktree,
  getRegistryWorktreeProvisionedChunk,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  insertRegistryWorktree,
  insertRegistryWorktreeProvisionedChunk,
  updateRegistryWorktree,
} from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import { initializeManagedWorktreeTestRepository } from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("managed worktree registry worker reads", () => {
  it("reads registry records without retiring a temporarily unavailable worktree", async () => {
    const root = tempDirs.make("worktree-registry-unavailable-");
    const repo = await initializeManagedWorktreeTestRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const now = 1_700_000_000_000;
    const service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const created = await service.create({
      repoRoot: repo,
      name: "read-only-list",
      baseRef: "HEAD",
    });
    await fs.rm(created.path, { recursive: true, force: true });
    expect(await service.listRegistryRecords()).toEqual([created]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await service.list()).toEqual([]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBe(now);
  });

  it("reads captured registry records and provisioned snapshots without host SQL or checkout reconciliation", async () => {
    const stateDir = tempDirs.make("worktree-registry-worker-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const service = new ManagedWorktreeService({ env });
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    sql.calibrate();

    expect(await getRegistryWorktreeProvisionedPaths(env, "missing")).toBeUndefined();
    expect(await getRegistryWorktreeProvisionedState(env, "missing")).toBeUndefined();
    expect(
      await getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: "missing",
        path: "synthetic.bin",
        chunkIndex: 0,
      }),
    ).toBeUndefined();
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(await readLiveRegistryWorktreeIds(env)).toEqual([]);
    expect((await fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).isFile()).toBe(true);
    sql.expectIdle();

    const older: ManagedWorktreeRecord = {
      id: "older",
      name: "older",
      repoFingerprint: "0123456789abcdef",
      repoRoot: path.join(stateDir, "missing-repo"),
      path: path.join(stateDir, "missing-checkouts", "older"),
      branch: "openclaw/older",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:task",
      createdAt: 10,
      lastActiveAt: 30,
      runEndCleanup: { outcome: "retained-dirty", at: 30 },
    };
    const removed: ManagedWorktreeRecord = {
      ...older,
      id: "a-removed",
      name: "a-removed",
      path: path.join(stateDir, "missing-checkouts", "a-removed"),
      createdAt: 20,
      removedAt: 40,
      snapshotRef: "refs/openclaw/snapshots/a-removed",
      runEndCleanup: { outcome: "removed-lossless", at: 40 },
    };
    const newer: ManagedWorktreeRecord = {
      ...older,
      id: "z-newer",
      name: "z-newer",
      path: path.join(stateDir, "missing-checkouts", "z-newer"),
      createdAt: 20,
      runEndCleanup: { outcome: "failed", at: 30, reason: "synthetic cleanup failure" },
    };
    insertRegistryWorktree(env, newer, { provisionedPaths: ["legacy.local"] });
    insertRegistryWorktree(env, older);
    insertRegistryWorktree(env, removed);
    const provisionedState = [{ path: "synthetic.bin", mode: 0o600, chunks: 2 }];
    updateRegistryWorktree(env, older.id, { provisionedState });
    const chunks = [Uint8Array.from([0, 255, 10]), Uint8Array.from([127, 0, 1])];
    for (const [chunkIndex, data] of chunks.entries()) {
      insertRegistryWorktreeProvisionedChunk(env, {
        worktreeId: older.id,
        path: "synthetic.bin",
        chunkIndex,
        data,
      });
    }
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET provisioned_paths_json = ? WHERE id = ?")
      .run("{malformed", removed.id);
    await closeOpenClawStateDatabaseAsync();
    sql.clear();

    const pending = service.listRegistryRecords();
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(await pending).toEqual([removed, newer, older]);
    await closeOpenClawStateDatabaseAsync();
    sql.expectIdle();

    env.OPENCLAW_STATE_DIR = stateDir;
    const listOptions = { liveOnly: true };
    const liveRecords = readRegistryWorktrees(env, listOptions);
    listOptions.liveOnly = false;
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(await liveRecords).toEqual([newer, older]);
    sql.expectIdle();

    env.OPENCLAW_STATE_DIR = stateDir;
    const snapshotReads = Promise.all([
      getRegistryWorktreeProvisionedPaths(env, older.id),
      getRegistryWorktreeProvisionedState(env, older.id),
    ]);
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(await snapshotReads).toEqual([["synthetic.bin"], provisionedState]);
    env.OPENCLAW_STATE_DIR = stateDir;
    const selectedChunk = { worktreeId: older.id, path: "synthetic.bin", chunkIndex: 0 };
    const firstChunk = getRegistryWorktreeProvisionedChunk(env, selectedChunk);
    selectedChunk.path = "different.bin";
    selectedChunk.chunkIndex = 1;
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(Array.from((await firstChunk)!)).toEqual(Array.from(chunks[0]!));
    env.OPENCLAW_STATE_DIR = stateDir;
    expect(
      Array.from(
        (await getRegistryWorktreeProvisionedChunk(env, {
          worktreeId: older.id,
          path: "synthetic.bin",
          chunkIndex: 1,
        }))!,
      ),
    ).toEqual(Array.from(chunks[1]!));
    expect(
      await getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: older.id,
        path: "synthetic.bin",
        chunkIndex: 2,
      }),
    ).toBeUndefined();
    expect(await getRegistryWorktreeProvisionedPaths(env, newer.id)).toEqual(["legacy.local"]);
    expect(await getRegistryWorktreeProvisionedState(env, newer.id)).toBeUndefined();
    expect(await getRegistryWorktreeProvisionedPaths(env, removed.id)).toBeUndefined();
    expect(await getRegistryWorktreeProvisionedState(env, removed.id)).toBeUndefined();
    await closeOpenClawStateDatabaseAsync();
    sql.expectIdle();
    await expect(fs.stat(path.join(stateDir, "unused-state"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const liveIds = readLiveRegistryWorktreeIds(env);
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect((await liveIds).toSorted()).toEqual([older.id, newer.id]);
    sql.expectIdle();

    env.OPENCLAW_STATE_DIR = stateDir;
    updateRegistryWorktree(env, older.id, { removedAt: 50 });
    updateRegistryWorktree(env, removed.id, { removedAt: undefined });
    sql.clear();
    expect((await readLiveRegistryWorktreeIds(env)).toSorted()).toEqual([removed.id, newer.id]);
    sql.expectIdle();
  });
});
