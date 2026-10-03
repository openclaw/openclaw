import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as gitWorker from "../../infra/git-worker.js";
import * as commandExec from "../../process/exec.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import * as allocation from "./allocation.js";
import * as worktreeGit from "./git.js";
import {
  getRegistryWorktree,
  getRegistryWorktreeProvisionedChunk,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
} from "./registry.js";
import * as runLease from "./run-lease.js";
import { ManagedWorktreeService, WorktreeSnapshotError } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeRecord,
  WorktreeSourceStage,
} from "./types.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
const directories = useStateDatabaseTempDirs();
const initialize = useManagedWorktreeTestRepository();
let repo: string;
let env: NodeJS.ProcessEnv;
let owner: ManagedWorktreeService;
let removed: ManagedWorktreeRecord;
let oldSnapshot: string;
let provisionedMode: number;
let now: number;
let allocationDepth: number;
let checkoutDepth: number;
let snapshotFailure: Error | undefined;
const events: string[] = [];

const withRollback: NonNullable<CreateManagedWorktreeParams["withRollback"]> = async (run) => {
  expect(allocationDepth).toBe(1);
  checkoutDepth += 1;
  try {
    return await run(() => expect(checkoutDepth).toBe(1));
  } finally {
    checkoutDepth -= 1;
  }
};

function unwindSource(failure: Error): WorktreeSourceStage {
  return async (run) => {
    await run({ assertCurrent: () => {}, assertCheckoutCurrent: () => {} });
    throw failure;
  };
}

function restoredRecord() {
  const record = { ...removed, lastActiveAt: now };
  delete record.removedAt;
  return record;
}

const payload = () => fs.readFile(path.join(removed.path, "local.env"), "utf8");
const oldChunk = () =>
  getRegistryWorktreeProvisionedChunk(env, {
    worktreeId: removed.id,
    path: "local.env",
    chunkIndex: 0,
  });

beforeEach(async () => {
  const root = directories.make("openclaw-restore-source-");
  repo = await initialize(root);
  env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  now = 10;
  owner = new ManagedWorktreeService({
    env,
    now: () => now,
    getConfig: () => ({ worktreeAcceleration: false }),
  });
  await fs.writeFile(path.join(repo, ".gitignore"), "local.env\n");
  await fs.writeFile(path.join(repo, ".worktreeinclude"), "local.env\n");
  await git(repo, "add", ".gitignore", ".worktreeinclude");
  await git(repo, "commit", "-m", "provision recovery content");
  await fs.writeFile(path.join(repo, "local.env"), "restored provisioned content", { mode: 0o600 });
  provisionedMode = (await fs.stat(path.join(repo, "local.env"))).mode & 0o7777;
  const created = await owner.create({ repoRoot: repo, name: "restored", baseRef: "HEAD" });
  now = 30;
  await owner.remove({ id: created.id, reason: "initial capture" });
  removed = getRegistryWorktree(env, created.id)!;
  oldSnapshot = await git(repo, "rev-parse", removed.snapshotRef!);
  now = 40;
  allocationDepth = checkoutDepth = 0;
  events.length = 0;
  snapshotFailure = undefined;

  const allocate = allocation.withWorktreeAllocationLease;
  vi.spyOn(allocation, "withWorktreeAllocationLease").mockImplementation(async (params, run) => {
    expect(allocationDepth).toBe(0);
    return await allocate(params, async (guard) => {
      allocationDepth += 1;
      try {
        return await run(guard);
      } finally {
        allocationDepth -= 1;
      }
    });
  });
  const claim = runLease.claimWorktreeRemoval;
  vi.spyOn(runLease, "claimWorktreeRemoval").mockImplementation((...args) => {
    expect(allocationDepth).toBe(1);
    expect(checkoutDepth).toBe(1);
    events.push("removal-claimed");
    return claim(...args);
  });
  vi.spyOn(runLease, "abortWorktreeRemoval");
  const operation = gitWorker.runGitWorkerOperation;
  vi.spyOn(gitWorker, "runGitWorkerOperation").mockImplementation(async (command, options) => {
    if (command.type === "worktree.snapshot" && snapshotFailure) {
      throw snapshotFailure;
    }
    const result = await operation(command, options);
    if (command.type === "worktree.snapshot") {
      events.push("snapshot-completed");
    }
    return result;
  });
  const runCommand = commandExec.runCommandWithTimeout;
  vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
    if (argv[0] === "git" && argv[argv.indexOf("worktree") + 1] === "remove") {
      events.push("checkout-removed");
    }
    return await runCommand(argv, options);
  });
});

afterEach(() => {
  expect(allocationDepth).toBe(0);
  expect(checkoutDepth).toBe(0);
});

it.each(["captured", "failed"] as const)(
  "compensates an acknowledged restore only with a complete recovery snapshot (%s)",
  async (snapshotOutcome) => {
    const rollback = vi.spyOn(owner, "rollbackPreparation");
    const sourceFailure = new Error("Source unwind failed after complete restore");
    const captureFailure = new Error("Recovery snapshot could not be captured");
    if (snapshotOutcome === "failed") {
      snapshotFailure = captureFailure;
    }
    const failure = await owner
      .createWithOutcome({
        repoRoot: repo,
        name: removed.name,
        withSource: unwindSource(sourceFailure),
        withRollback,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(rollback).toHaveBeenCalledExactlyOnceWith(restoredRecord(), withRollback);
    const snapshotCalls = vi
      .mocked(gitWorker.runGitWorkerOperation)
      .mock.calls.filter(([command]) => command.type === "worktree.snapshot");
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]?.[0]).toMatchObject({
      type: "worktree.snapshot",
      input: {
        worktreeId: removed.id,
        checkoutPath: removed.path,
        provisionedPaths: ["local.env"],
      },
    });
    const record = getRegistryWorktree(env, removed.id);
    if (snapshotOutcome === "captured") {
      expect(failure).toBe(sourceFailure);
      expect(record).toMatchObject({ removedAt: now, snapshotRef: removed.snapshotRef });
      expect(await git(repo, "rev-parse", removed.snapshotRef!)).not.toBe(oldSnapshot);
      expect(await getRegistryWorktreeProvisionedState(env, removed.id)).toEqual([
        { path: "local.env", mode: provisionedMode, chunks: 1 },
      ]);
      await expect(fs.stat(removed.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(events.indexOf("snapshot-completed")).toBeLessThan(events.indexOf("checkout-removed"));
    } else {
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected primary source failure and recovery failure");
      }
      expect(failure.cause).toBe(sourceFailure);
      expect(failure.errors[0]).toBe(sourceFailure);
      expect(failure.errors[1]).toBeInstanceOf(WorktreeSnapshotError);
      expect(collectNestedErrorCandidates(failure)).toContain(captureFailure);
      expect(record?.removedAt).toBeUndefined();
      expect(await payload()).toBe("restored provisioned content");
      expect(await getRegistryWorktreeProvisionedPaths(env, removed.id)).toEqual(["local.env"]);
      expect(await getRegistryWorktreeProvisionedState(env, removed.id)).toBeUndefined();
      expect(await oldChunk()).toBeUndefined();
      expect(events).not.toContain("checkout-removed");
      expect(runLease.abortWorktreeRemoval).toHaveBeenCalledWith(
        env,
        removed.id,
        expect.any(String),
      );
    }
  },
);

it.each(["unacknowledged restore", "live checkout"] as const)(
  "does not claim %s after source unwind",
  async (state) => {
    const rollback = vi.spyOn(owner, "rollbackPreparation");
    const restoreFailure = new Error("Final restore recovery-ref cleanup did not complete");
    const sourceFailure = new Error("Source unwind after live reuse");
    if (state === "live checkout") {
      await owner.restore({ id: removed.id });
      await fs.writeFile(path.join(removed.path, "local.env"), "existing user content");
    } else {
      const requireGit = worktreeGit.requireGit;
      vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (cwd, args, options) => {
        if (
          args[0] === "update-ref" &&
          args[1] === "-d" &&
          args.length === 3 &&
          args[2] === `refs/openclaw/removals/${removed.id}`
        ) {
          throw restoreFailure;
        }
        return await requireGit(cwd, args, options);
      });
    }
    await expect(
      owner.createWithOutcome({
        repoRoot: repo,
        name: removed.name,
        withSource: unwindSource(sourceFailure),
        withRollback,
      }),
    ).rejects.toBe(state === "live checkout" ? sourceFailure : restoreFailure);
    expect(rollback).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(gitWorker.runGitWorkerOperation)
        .mock.calls.some(([command]) => command.type === "worktree.snapshot"),
    ).toBe(false);
    expect(getRegistryWorktree(env, removed.id)?.removedAt).toBeUndefined();
    expect(await payload()).toBe(
      state === "live checkout" ? "existing user content" : "restored provisioned content",
    );
    expect(events).not.toContain("removal-claimed");
  },
);

it("still permits discarding a fresh preparation when its first snapshot fails", async () => {
  const fresh = await owner.create({ repoRoot: repo, name: "fresh", baseRef: "HEAD" });
  snapshotFailure = new Error("First preparation snapshot failed");
  await owner.rollbackPreparation(fresh, withRollback);
  await expect(fs.stat(fresh.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(getRegistryWorktree(env, fresh.id)).toMatchObject({ removedAt: now });
  expect(getRegistryWorktree(env, fresh.id)?.snapshotRef).toBeUndefined();
  expect(events).toContain("checkout-removed");
});
