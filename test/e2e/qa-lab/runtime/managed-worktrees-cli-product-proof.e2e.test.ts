// QA Lab product proof for the managed-worktree child CLI lifecycle.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
} from "../../../../src/agents/worktrees/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { git, initializeRepository, readText } from "./managed-worktrees-product-proof-fixture.js";

const WORKTREE_NAME = "qa-managed-worktree";

type WorktreeListJson = { worktrees: ManagedWorktreeRecord[] };

let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await instance?.cleanup();
  instance = undefined;
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function worktrees<T>(...args: string[]): Promise<T> {
  if (!instance) {
    throw new Error("CLI fixture is not running");
  }
  const result = await instance.cli(["worktrees", ...args, "--json"]);
  if (result.code !== 0) {
    throw new Error(
      `worktrees ${args.join(" ")} failed with exit ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

it(
  "creates, snapshots, restores, and preserves a manual worktree through the CLI",
  { timeout: 180_000 },
  async () => {
    const canonicalTmp = await fs.realpath(os.tmpdir());
    const tempRoot = tempDirs.make("openclaw-managed-worktree-cli-", canonicalTmp);
    const { baseCommit, repo } = await initializeRepository(tempRoot);
    instance = await createOpenClawTestInstance({ name: "qa-managed-worktree-cli" });
    const stateDir = await fs.realpath(instance.stateDir);

    const created = await worktrees<ManagedWorktreeRecord>(
      "create",
      repo,
      "--name",
      WORKTREE_NAME,
      "--base-ref",
      "HEAD",
    );
    expect(created).toMatchObject({
      name: WORKTREE_NAME,
      repoRoot: repo,
      branch: `openclaw/${WORKTREE_NAME}`,
      baseRef: "HEAD",
      ownerKind: "manual",
      id: expect.any(String),
      createdAt: expect.any(Number),
      lastActiveAt: expect.any(Number),
    });
    expect(await fs.realpath(created.path)).toBe(
      path.join(stateDir, "worktrees", created.repoFingerprint, WORKTREE_NAME),
    );
    expect(await git(repo, "rev-parse", `refs/heads/${created.branch}`)).toBe(baseCommit);

    await fs.writeFile(path.join(created.path, "README.md"), "dirty tracked change\n");
    await fs.writeFile(path.join(created.path, "notes.txt"), "restored note\n");

    const removed = await worktrees<RemoveManagedWorktreeResult>("remove", created.id);
    const expectedSnapshotRef = `refs/openclaw/snapshots/${created.id}`;
    expect(removed).toEqual({ removed: true, snapshotRef: expectedSnapshotRef });
    const snapshotCommit = await git(repo, "rev-parse", expectedSnapshotRef);
    await expect(fs.access(created.path)).rejects.toMatchObject({ code: "ENOENT" });

    const removedList = await worktrees<WorktreeListJson>("list");
    expect(removedList.worktrees).toContainEqual(
      expect.objectContaining({ id: created.id, removedAt: expect.any(Number) }),
    );

    const restored = await worktrees<ManagedWorktreeRecord>("restore", created.id);
    expect(restored).toMatchObject({
      id: created.id,
      branch: created.branch,
      path: created.path,
    });
    expect(restored.removedAt).toBeUndefined();
    const status = await git(restored.path, "status", "--porcelain");
    expect(status.split("\n")).toEqual(expect.arrayContaining([" M README.md", "?? notes.txt"]));
    await expect(readText(restored.path, "README.md")).resolves.toBe("dirty tracked change\n");
    await expect(readText(restored.path, "notes.txt")).resolves.toBe("restored note\n");
    expect(await git(repo, "rev-parse", `refs/heads/${created.branch}`)).toBe(baseCommit);
    expect((await git(repo, "log", "--format=%H", created.branch)).split("\n")).not.toContain(
      snapshotCommit,
    );

    const gc = await worktrees<ManagedWorktreeGcResult>("gc");
    expect(gc).toMatchObject({
      removed: [],
      orphansDeleted: expect.any(Number),
      snapshotsPruned: expect.any(Number),
    });
    const activeList = await worktrees<WorktreeListJson>("list");
    const active = activeList.worktrees.find((record) => record.id === created.id);
    expect(active).toMatchObject({ id: created.id, ownerKind: "manual" });
    expect(active?.removedAt).toBeUndefined();
    await fs.access(created.path);
  },
);
