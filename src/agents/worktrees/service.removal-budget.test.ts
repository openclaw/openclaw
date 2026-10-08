import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
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
