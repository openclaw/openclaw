import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { getRegistryWorktree, insertRegistryWorktree } from "./registry.js";
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

  it("creates and reopens the captured registry without host SQL or checkout reconciliation", async () => {
    const stateDir = tempDirs.make("worktree-registry-worker-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const service = new ManagedWorktreeService({ env });
    const native = requireNodeSqlite();
    const counters = [
      vi.spyOn(native.DatabaseSync.prototype, "prepare"),
      vi.spyOn(native.DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(native.StatementSync.prototype, method),
      ),
    ];
    const clearCounters = () => {
      for (const counter of counters) {
        counter.mockClear();
      }
    };
    const calibration = new native.DatabaseSync(":memory:");
    try {
      calibration.exec("CREATE TABLE calibration (value INTEGER)");
      calibration.prepare("INSERT INTO calibration VALUES (?)").run(1);
      const read = calibration.prepare("SELECT value FROM calibration");
      read.get();
      read.all();
      expect([...read.iterate()]).toHaveLength(1);
      expect(counters.every((counter) => counter.mock.calls.length > 0)).toBe(true);
    } finally {
      calibration.close();
      clearCounters();
    }

    expect(await service.listRegistryRecords()).toEqual([]);
    expect((await fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).isFile()).toBe(true);
    expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);

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
    insertRegistryWorktree(env, newer);
    insertRegistryWorktree(env, older);
    insertRegistryWorktree(env, removed);
    await closeOpenClawStateDatabaseAsync();
    clearCounters();

    const pending = service.listRegistryRecords();
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(await pending).toEqual([removed, newer, older]);
    await closeOpenClawStateDatabaseAsync();
    expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
