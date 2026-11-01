import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { updateRegistryWorktree } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { hasLiveWorktreeRunLease, testing as runLeaseTesting } from "./run-lease.test-support.js";
import { classifyWorktreeRemovalError, IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import { git, useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

const initializeRepository = useManagedWorktreeTestRepository();
const tempDirs = useWorktreeStateRoots(() => {
  resetConfigRuntimeState();
  runLeaseTesting.resetForTest();
});
let repo: string;
let env: NodeJS.ProcessEnv;
let service: ManagedWorktreeService;
let created: { id: string; path: string };

beforeEach(async () => {
  const root = tempDirs.make("openclaw-remove-lease-");
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

const remove = (allowSnapshotLoss?: true) =>
  service.remove({ id: created.id, reason: "manual-delete", allowSnapshotLoss });
const snapshotFailure = "nested git repositories cannot be snapshotted losslessly";
const expectGone = () => expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
async function createNestedRepository(target: string) {
  const nested = path.join(target, "nested");
  await fs.mkdir(nested);
  await git(nested, "init", "-b", "main");
}

it.each([false, true])("rejects removal with a live lease (snapshot retry: %s)", async (retry) => {
  if (retry) {
    await createNestedRepository(created.path);
    await expect(remove()).rejects.toThrow(snapshotFailure);
  }
  const lease = await acquireWorktreeRunLease(created.id, { env });
  const removalError = await remove(retry || undefined)
    .then(() => undefined)
    .catch((error: unknown) => error);
  expect(removalError).toBeInstanceOf(Error);
  expect((removalError as Error).message).toContain("worktree is busy");
  expect(classifyWorktreeRemovalError(removalError)).toBe("busy");
  expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
  expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);
  expect(await fs.stat(created.path)).toBeTruthy();

  await lease.release();
  if (!retry) {
    expect((await remove()).removed).toBe(true);
    await expectGone();
  }
});

it("does not let snapshot-loss permission bypass a foreign Git lock", async () => {
  await git(repo, "worktree", "lock", "--reason", "other-tool", created.path);

  await expect(remove(true)).rejects.toThrow("worktree has a foreign lock: other-tool");
  expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  expect(await fs.stat(created.path)).toBeTruthy();
});

it("continues after snapshot failure when snapshot loss is allowed", async () => {
  await createNestedRepository(created.path);

  const started = Date.now();
  const result = await remove(true);

  expect(result).toEqual({
    removed: true,
    snapshotError: expect.stringContaining(snapshotFailure),
  });
  expect(getRegistryWorktree(env, created.id)?.removedAt).toBeGreaterThanOrEqual(started);
  expect(getRegistryWorktree(env, created.id)?.removedAt).toBeLessThanOrEqual(Date.now());
  await expectGone();
});

it("allows only one concurrent remover to own the claim", async () => {
  const results = await Promise.allSettled([remove(), remove()]);
  const completed = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  const contention = { message: expect.stringMatching(/in progress|unknown active worktree/) };
  expect(completed).toMatchObject([{ value: { removed: true } }]);
  expect(rejected).toMatchObject([{ reason: contention }]);
  await expectGone();
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
