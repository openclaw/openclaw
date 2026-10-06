import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "../../agents/worktrees/service.js";
import * as processExec from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  cleanupWorkerWorkspaceResultRef,
  deleteStagedWorkerWorkspaceResult,
  deleteWorkerWorkspaceResultCleanupRefs,
  hasWorkerWorkspaceResultRef,
  moveStagedWorkerWorkspaceResultToCleanup,
  preparedWorkerWorkspaceResultRef,
  restoreStagedWorkerWorkspaceResultFromCleanup,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

async function repository() {
  const root = await fs.realpath(tempDirs.make("openclaw-workspace-ref-"));
  await requireGit(root, ["init", "--quiet", "-b", "main"]);
  await requireGit(root, [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@localhost",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  ]);
  return root;
}

it("shares ref serialization and deferred retention between snapshots and result recovery", async (ctx) => {
  let phase = "repositories";
  let resultDiscoveries = 0;
  let reported = false;
  const settlements = { gc: "not_started", move: "not_started", cleanup: "not_started" };
  const commands: Array<{
    verb: "update-ref" | "common-dir";
    root: "subject" | "linked" | "other" | "unknown";
    status: "pending" | "settled" | "rejected";
    termination?: processExec.SpawnResult["termination"];
    code?: number | null;
  }> = [];
  const report = () => {
    if (reported) {
      return;
    }
    reported = true;
    console.error(
      "workspace-ref-phase",
      JSON.stringify({ phase, resultDiscoveries, settlements, commands }),
    );
  };
  // Capture the stalled phase before timeout cleanup changes the observed owners.
  ctx.signal.addEventListener("abort", report, { once: true });
  ctx.onTestFailed(report);
  ctx.onTestFinished(() => ctx.signal.removeEventListener("abort", report));
  const observe = <T>(owner: keyof typeof settlements, work: Promise<T>): Promise<T> => {
    settlements[owner] = "pending";
    void work.then(
      () => {
        settlements[owner] = "fulfilled";
      },
      () => {
        settlements[owner] = "rejected";
      },
    );
    return work;
  };
  vi.stubEnv("GIT_COMMON_DIR", undefined);
  const root = await repository();
  const other = await repository();
  let now = 1_700_000_000_000;
  const service = new ManagedWorktreeService({
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    now: () => now,
  });
  phase = "create";
  const worktree = await service.create({ repoRoot: root, name: "snapshot", baseRef: "HEAD" });
  phase = "remove";
  const removed = await service.remove({ id: worktree.id, reason: "test" });
  phase = "ref_setup";
  const snapshotRef = expectDefined(removed.snapshotRef, "removed worktree snapshot");
  const snapshotHead = await requireGit(root, ["rev-parse", `${snapshotRef}^{commit}`]);
  const linked = path.join(root, "linked");
  await requireGit(root, ["worktree", "add", "--detach", linked, "HEAD"]);
  const stagedResultRef = workerWorkspaceResultRef("queued-result");
  const candidateRef = preparedWorkerWorkspaceResultRef(stagedResultRef);
  for (const repositoryRoot of [root, other]) {
    await requireGit(repositoryRoot, ["update-ref", stagedResultRef, "HEAD"]);
    await requireGit(repositoryRoot, ["update-ref", candidateRef, "HEAD"]);
  }
  const retainedRef = cleanupWorkerWorkspaceResultRef(workerWorkspaceResultRef("retained"));
  await requireGit(root, ["update-ref", retainedRef, "HEAD"]);
  const retainedRefs = new Set<string>();
  const readRetainedRefs = vi.fn(() => retainedRefs);
  now += SNAPSHOT_RETENTION_MS + 1;

  const started = createDeferred();
  const release = createDeferred();
  const discovered = createDeferred();
  const mutations: string[][] = [];
  const run = processExec.runCommandWithTimeout;
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
    const args = argv.slice(argv.indexOf("-C") + 2);
    const commandRoot = argv[argv.indexOf("-C") + 1];
    const verb =
      args[0] === "update-ref"
        ? "update-ref"
        : args[0] === "rev-parse" && args[1] === "--git-common-dir"
          ? "common-dir"
          : undefined;
    const receipt: (typeof commands)[number] | undefined = verb
      ? {
          verb,
          root:
            commandRoot === root
              ? "subject"
              : commandRoot === linked
                ? "linked"
                : commandRoot === other
                  ? "other"
                  : "unknown",
          status: "pending",
        }
      : undefined;
    if (receipt) {
      if (commands.length === 8) {
        commands.shift();
      }
      commands.push(receipt);
    }
    if (args[0] === "update-ref" && argv[argv.indexOf("-C") + 1] !== other) {
      mutations.push(args);
      if (args[1] === "-d" && args[2] === snapshotRef) {
        started.resolve();
        await release.promise;
      }
    }
    let result: processExec.SpawnResult;
    try {
      result = await run(argv, options);
    } catch (error) {
      if (receipt) {
        receipt.status = "rejected";
      }
      throw error;
    }
    if (receipt) {
      receipt.status = "settled";
      receipt.termination = result.termination;
      receipt.code = result.code;
    }
    if (
      argv[argv.indexOf("-C") + 1] === linked &&
      args[0] === "rev-parse" &&
      args[1] === "--git-common-dir" &&
      ++resultDiscoveries === 2
    ) {
      discovered.resolve();
    }
    return result;
  });
  phase = "gc_admission";
  const pruning = observe("gc", service.gc());
  let move: Promise<string> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    await started.promise;
    phase = "ref_discovery";
    move = observe(
      "move",
      moveStagedWorkerWorkspaceResultToCleanup({ root: linked, stagedResultRef }),
    );
    cleanup = observe(
      "cleanup",
      deleteWorkerWorkspaceResultCleanupRefs({
        root: linked,
        retainedRefs: readRetainedRefs,
      }),
    );
    // Both writers must capture their environment before the redirect below.
    await discovered.promise;
    phase = "independent_write";
    // An independent full ref operation must progress while this repository's
    // writer is parked; a quick read alone can outrun the queued caller's discovery.
    await moveStagedWorkerWorkspaceResultToCleanup({ root: other, stagedResultRef });
    await expect(hasWorkerWorkspaceResultRef({ root: linked, stagedResultRef })).resolves.toBe(
      true,
    );
    expect(mutations).toEqual([["update-ref", "-d", snapshotRef, snapshotHead]]);
    expect(readRetainedRefs).not.toHaveBeenCalled();
    // A queued result writer must not adopt a later repository redirect.
    vi.stubEnv("GIT_COMMON_DIR", path.join(other, ".git"));
  } finally {
    phase = "release_join";
    retainedRefs.add(retainedRef);
    release.resolve();
    await Promise.allSettled([pruning, ...(move ? [move] : []), ...(cleanup ? [cleanup] : [])]);
    vi.stubEnv("GIT_COMMON_DIR", undefined);
  }
  phase = "postconditions";
  await cleanup;
  expect(readRetainedRefs).toHaveBeenCalledOnce();
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: retainedRef })).resolves.toBe(
    true,
  );
  expect((await pruning).snapshotsPruned).toBe(1);
  const cleanupRef = await expectDefined(move, "queued worker result move");
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef })).resolves.toBe(false);
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: candidateRef })).resolves.toBe(
    false,
  );
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: cleanupRef })).resolves.toBe(
    true,
  );

  await restoreStagedWorkerWorkspaceResultFromCleanup({
    root: linked,
    cleanupRef,
    stagedResultRef,
  });
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef })).resolves.toBe(true);
  await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: cleanupRef })).resolves.toBe(
    false,
  );
  await moveStagedWorkerWorkspaceResultToCleanup({ root: linked, stagedResultRef });
  await deleteWorkerWorkspaceResultCleanupRefs({ root: linked });
  expect(await requireGit(root, ["for-each-ref", "--format=%(refname)", "refs/openclaw/"])).toBe(
    "",
  );
});

it.each([false, true])(
  "preserves native external packed-ref contention without retrying or deleting its lock (bare=%s)",
  async (bare) => {
    let root = await repository();
    if (bare) {
      const bareRoot = path.join(tempDirs.make("openclaw-workspace-bare-ref-"), "repo.git");
      await requireGit(root, ["clone", "--bare", "--no-hardlinks", "--", root, bareRoot]);
      root = await fs.realpath(bareRoot);
    }
    const stagedResultRef = workerWorkspaceResultRef("external-lock");
    await requireGit(root, ["update-ref", stagedResultRef, "HEAD"]);
    const lock = path.join(root, bare ? "." : ".git", "packed-refs.lock");
    await fs.writeFile(lock, "external owner\n", { flag: "wx" });
    const commandSpy = vi.spyOn(processExec, "runCommandWithTimeout");
    try {
      await expect(deleteStagedWorkerWorkspaceResult({ root, stagedResultRef })).rejects.toThrow(
        "packed-refs.lock",
      );
      await expect(fs.readFile(lock, "utf8")).resolves.toBe("external owner\n");
      await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef })).resolves.toBe(true);
      const deleteAttempts = commandSpy.mock.calls.filter(([argv]) =>
        argv.includes("update-ref"),
      ).length;
      expect(deleteAttempts).toBe(1);
    } finally {
      await fs.rm(lock, { force: true });
    }
    await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef });
    await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef })).resolves.toBe(false);
  },
);
