import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { updateRegistryWorktree } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { hasLiveWorktreeRunLease, testing as runLeaseTesting } from "./run-lease.test-support.js";
import { classifyWorktreeRemovalError, IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import { git, useManagedWorktreeTestRepository } from "./service.test-support.js";

describe("ManagedWorktreeService removal against a live run lease", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let created: { id: string; path: string };

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-remove-lease-"));
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    setRuntimeConfigSnapshot({}, {});
    service = new ManagedWorktreeService({ env });
    created = await service.create({
      repoRoot: repo,
      name: "removal-session",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:removal",
    });
  });

  afterEach(async () => {
    resetConfigRuntimeState();
    runLeaseTesting.resetForTest();
    await closeStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  const remove = (allowSnapshotLoss?: true) =>
    service.remove({ id: created.id, reason: "manual-delete", allowSnapshotLoss });
  async function createNestedRepository(target: string) {
    const nested = path.join(target, "nested");
    await fs.mkdir(nested);
    await git(nested, "init", "-b", "main");
  }

  it("rejects removal before snapshotting while a run lease is live", async () => {
    const lease = await acquireWorktreeRunLease(created.id, { env });

    const removalError = await remove()
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(removalError).toBeInstanceOf(Error);
    expect((removalError as Error).message).toContain("worktree is busy");
    expect(classifyWorktreeRemovalError(removalError)).toBe("busy");
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(created.path)).toBeTruthy();

    await lease.release();
    expect((await remove()).removed).toBe(true);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let snapshot-loss permission bypass a foreign Git lock", async () => {
    await git(repo, "worktree", "lock", "--reason", "other-tool", created.path);

    await expect(remove(true)).rejects.toThrow("worktree has a foreign lock: other-tool");
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(created.path)).toBeTruthy();
  });

  it("rejects a snapshot-loss retry when a run starts after snapshot failure", async () => {
    await createNestedRepository(created.path);

    await expect(remove()).rejects.toThrow(
      "nested git repositories cannot be snapshotted losslessly",
    );
    const lease = await acquireWorktreeRunLease(created.id, { env });

    await expect(remove(true)).rejects.toThrow("worktree is busy");
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(created.path)).toBeTruthy();

    await lease.release();
  });

  it("continues after snapshot failure when snapshot loss is allowed", async () => {
    await createNestedRepository(created.path);

    const started = Date.now();
    const result = await remove(true);

    expect(result).toEqual({
      removed: true,
      snapshotError: expect.stringContaining(
        "nested git repositories cannot be snapshotted losslessly",
      ),
    });
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeGreaterThanOrEqual(started);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeLessThanOrEqual(Date.now());
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one concurrent remover to own the claim", async () => {
    const results = await Promise.allSettled([remove(), remove()]);
    const completed = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.value.removed).toBe(true);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      message: expect.stringMatching(/in progress|unknown active worktree/),
    });
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips idle garbage collection for a worktree with a live run lease", async () => {
    await updateRegistryWorktree(env, created.id, { lastActiveAt: Date.now() - IDLE_GC_MS - 1 });
    const lease = await acquireWorktreeRunLease(created.id, { env });

    const skipped = await service.gc();
    expect(skipped.removed).toEqual([]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();

    await lease.release();
    const collected = await service.gc();
    expect(collected.removed).toContain(created.id);
  });
});
