import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { requireGit } from "./git.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { isWorktreeRepositoryCorruptionError } from "./removal-errors.js";
import { resolveRepository } from "./service-preparation.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const initializeRepository = useManagedWorktreeTestRepository();

it.each([
  ["error: invalid object 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa for 'file'", true],
  ["fatal: loose object aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is corrupt", true],
  ["error: object file .git/objects/aa/aaaaaaaa is empty", true],
  ["fatal: unable to read tree aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true],
  ["fatal: not a tree object", true],
  ["fatal: unable to read aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true],
  ["fatal: could not fetch aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa from promisor remote", true],
  ["fatal: Unable to create 'index.lock': File exists", false],
  ["fatal: unable to access 'remote': Could not resolve host", false],
  ["git-write-tree: error building trees", false],
])(
  "classifies object-storage evidence without deferring unrelated Git failures: %s",
  (message, corrupt) => {
    expect(
      isWorktreeRepositoryCorruptionError(
        new Error("snapshot failed", { cause: new Error(message) }),
      ),
    ).toBe(corrupt);
  },
);

it("backs off the shared repository after a missing-object snapshot failure", async () => {
  const root = tempDirs.make("worktree-corrupt-repository-");
  const source = await initializeRepository(root);
  await fs.writeFile(path.join(source, "missing.txt"), "omitted blob\n");
  await requireGit(source, ["add", "missing.txt"]);
  await requireGit(source, ["commit", "-m", "add omitted blob"]);
  await requireGit(source, ["config", "uploadpack.allowFilter", "true"]);
  const repoRoot = path.join(root, "partial");
  await requireGit(root, [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    pathToFileURL(source).href,
    repoRoot,
  ]);
  await requireGit(repoRoot, ["sparse-checkout", "set", "--no-cone", "/README.md"]);
  await requireGit(repoRoot, ["checkout", "main"]);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const records = await materializeManagedWorktreeFixtures({
    env,
    stateDir,
    repoRoot,
    repoFingerprint: (await resolveRepository(repoRoot)).fingerprint,
    names: ["broken-a", "broken-b"],
    now: 1,
    ownerKind: "session",
  });
  await requireGit(repoRoot, ["remote", "set-url", "origin", path.join(root, "unavailable")]);
  for (const record of records) {
    await fs.writeFile(path.join(record.path, "README.md"), "retained changes\n");
    // Materialized bytes do not repair the missing object in the shared store.
    await fs.writeFile(path.join(record.path, "missing.txt"), "omitted blob\n");
  }
  const hour = 60 * 60_000;
  let now = IDLE_GC_MS + 2;
  const commands = [
    vi.spyOn(gitExec, "executeGitCommand"),
    vi.spyOn(gitExec, "executeGitCommandBytes"),
    vi.spyOn(gitExec, "executeGitCommandBuffered"),
  ];
  const gc = (retryDeferred = false) =>
    new ManagedWorktreeService({ env, now: () => now }).gc({ retryDeferred });
  const initialStarted = performance.now();
  const first = await gc();
  const initial = {
    gitSpawns: commands.reduce((sum, command) => sum + command.mock.calls.length, 0),
    elapsedMs: performance.now() - initialStarted,
    rssBytes: process.memoryUsage().rss,
  };
  await closeOpenClawStateDatabaseAsync();
  now += hour;
  for (const command of commands) {
    command.mockClear();
  }
  const started = performance.now();
  const second = await gc();
  const gitSpawns = commands.reduce((sum, command) => sum + command.mock.calls.length, 0);
  console.log(
    JSON.stringify({
      initial,
      repositoryBackoff: {
        gitSpawns,
        elapsedMs: performance.now() - started,
        rssBytes: process.memoryUsage().rss,
      },
    }),
  );
  expect(first.failedCount).toBe(1);
  expect(first.deferredCount).toBe(1);
  expect(first.issues.map((issue) => issue.reason).join("\n")).toContain(
    "has missing or corrupt Git objects",
  );
  expect(first.issues.map((issue) => issue.reason).join("\n")).toMatch(/repair/i);
  const failed = records.find((record) => getRegistryWorktree(env, record.id)?.gcRetry)!;
  expect(getRegistryWorktree(env, failed.id)?.gcRetry).toMatchObject({
    stage: "repository-corrupt",
    attempts: 1,
    retryAt: now + hour,
  });
  expect(second.deferredCount).toBe(2);
  expect(gitSpawns).toBe(0);

  now += hour;
  expect((await gc()).failedCount).toBe(1);
  expect(getRegistryWorktree(env, failed.id)?.gcRetry).toMatchObject({
    attempts: 2,
    retryAt: now + 4 * hour,
  });
  const healthy = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot: source,
    name: "healthy",
    now: 1,
    ownerKind: "session",
  });
  expect((await gc()).removed).toEqual([healthy.id]);
  await requireGit(repoRoot, ["remote", "set-url", "origin", source]);
  await requireGit(repoRoot, ["cat-file", "blob", "HEAD:missing.txt"]);
  expect((await gc(true)).removed.toSorted()).toEqual(
    records.map((record) => record.id).toSorted(),
  );
  for (const record of records) {
    const restored = await new ManagedWorktreeService({ env, now: () => now }).restore({
      id: record.id,
    });
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "retained changes\n",
    );
  }
});

it("records an admitted deletion timeout after its caller cancels and loses session authority", async () => {
  const root = tempDirs.make("worktree-removal-cancelled-budget-");
  const repoRoot = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const record = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot,
    name: "cancelled",
    now: 1,
  });
  const controller = new AbortController();
  let current = true;
  const execute = gitExec.executeGitCommand;
  vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
    if (args[0] === "worktree" && args[1] === "remove") {
      options?.beforeRun?.();
      await fs.unlink(path.join(record.path, "README.md"));
      current = false;
      controller.abort(new Error("caller cancelled"));
      return {
        stdout: "",
        stderr: "",
        code: null,
        signal: "SIGTERM",
        killed: true,
        termination: "timeout",
        timeoutMs: 300_000,
      };
    }
    return await execute(cwd, args, options);
  });
  await expect(
    new ManagedWorktreeService({ env }).remove({
      id: record.id,
      reason: "idle-gc",
      signal: controller.signal,
      commitGuard: () => {
        if (!current) {
          throw new Error("session retired");
        }
      },
    }),
  ).rejects.toThrow();
  expect(getRegistryWorktree(env, record.id)?.gcRetry).toMatchObject({
    stage: "checkoutRemoval",
    attempts: 1,
  });
  expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
});

it("persists timeout backoff across restart and retries only when due or explicitly requested", async () => {
  const root = tempDirs.make("worktree-removal-budget-");
  const repoRoot = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const record = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot,
    name: "timed-out",
    now: 1,
    ownerKind: "session",
  });
  await fs.writeFile(path.join(record.path, "README.md"), "retained changes\n");
  const hour = 60 * 60_000;
  let now = IDLE_GC_MS + 2;
  let attempts = 0;
  let fail = true;
  const execute = gitExec.executeGitCommandBytes;
  vi.spyOn(gitExec, "executeGitCommandBytes").mockImplementation(async (cwd, args, options) => {
    if (args.includes("write-tree")) {
      attempts++;
      if (fail) {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: null,
          signal: "SIGTERM",
          killed: true,
          termination: "timeout",
          timeoutMs: 120_000,
          windowsEncoding: null,
        };
      }
    }
    return await execute(cwd, args, options);
  });
  const gc = () => new ManagedWorktreeService({ env, now: () => now }).gc();
  expect((await gc()).outcome).toBe("partial");
  const first = getRegistryWorktree(env, record.id)?.gcRetry;
  expect(first).toEqual({
    stage: "snapshot",
    elapsedMs: expect.any(Number),
    attempts: 1,
    retryAt: now + 2 * hour,
  });
  expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("retained changes\n");

  await closeOpenClawStateDatabaseAsync();
  now += hour;
  expect((await gc()).outcome).toBe("deferred");
  expect(attempts).toBe(1);
  expect(getRegistryWorktree(env, record.id)?.gcRetry).toEqual(first);

  now += hour;
  expect((await gc()).outcome).toBe("partial");
  expect(attempts).toBe(2);
  expect(getRegistryWorktree(env, record.id)?.gcRetry).toMatchObject({
    attempts: 2,
    retryAt: now + 4 * hour,
  });
  fail = false;
  const retried = await new ManagedWorktreeService({ env, now: () => now }).gc({
    retryDeferred: true,
  });
  expect(retried.removed).toEqual([record.id]);
  expect(attempts).toBe(3);
  expect(getRegistryWorktree(env, record.id)?.gcRetry).toBeUndefined();
  const restored = await new ManagedWorktreeService({ env, now: () => now }).restore({
    id: record.id,
  });
  expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
    "retained changes\n",
  );
});
