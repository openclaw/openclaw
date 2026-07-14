import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deleteRegistryWorktree,
  findRegistryWorktreeByPath,
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  insertRegistryWorktree,
  listRegistryWorktrees,
  updateRegistryWorktree,
} from "./registry.js";
import type { ManagedWorktreeRecord } from "./types.js";

describe("managed worktree registry", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-registry-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
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
    insertRegistryWorktree(env, record);
    insertRegistryWorktree(env, {
      ...record,
      id: "second",
      name: "task-2",
      path: path.join(root, "worktrees", "task-2"),
      createdAt: 20,
      lastActiveAt: 20,
    });

    expect(listRegistryWorktrees(env).map((entry) => entry.id)).toEqual(["second", "first"]);
    expect(findLiveRegistryWorktreeByPath(env, record.path)).toMatchObject({
      id: "first",
      ownerKind: "workboard",
      ownerId: "card-1",
    });

    updateRegistryWorktree(env, "first", {
      lastActiveAt: 30,
      removedAt: 40,
      snapshotRef: "refs/openclaw/snapshots/first",
    });
    expect(getRegistryWorktree(env, "first")).toMatchObject({
      lastActiveAt: 30,
      removedAt: 40,
      snapshotRef: "refs/openclaw/snapshots/first",
    });
    expect(findLiveRegistryWorktreeByPath(env, record.path)).toBeUndefined();
    expect(findRegistryWorktreeByPath(env, record.path)?.id).toBe("first");

    deleteRegistryWorktree(env, "first");
    expect(getRegistryWorktree(env, "first")).toBeUndefined();
  });
});
