import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNestedGitEnv } from "../../test/helpers/temp-repo.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import type { runGitBytes } from "../agents/worktrees/git.js";
import { removeManagedCheckout } from "../agents/worktrees/removal-git.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withContentGitSlot } from "./git-content-budget.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { resolveWorkerPoolSize } from "./worker-pool-sizing.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  vi.restoreAllMocks();
});

function settle<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ rejected: false as const, value }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
}

it("admits summary reads ahead of queued content without starving content or exceeding two slots", async ({
  signal,
}) => {
  const started: string[] = [];
  const releases = Array.from({ length: 5 }, () => createDeferredCore());
  const entered = Array.from({ length: 5 }, () => createDeferredCore());
  let active = 0;
  let maximum = 0;
  const run = (index: number, interactive = false) =>
    withContentGitSlot(
      async () => {
        started.push(String(index));
        maximum = Math.max(maximum, ++active);
        entered[index]!.resolve();
        try {
          await releases[index]!.promise;
        } finally {
          active--;
        }
      },
      signal,
      interactive,
    );
  const pending = [run(0), run(1), run(2), run(3, true), run(4, true)];
  try {
    await withinTest(Promise.all([entered[0]!.promise, entered[1]!.promise]), signal);
    releases[0]!.resolve();
    await pending[0];
    expect(started).toEqual(["0", "1", "3"]);
    releases[1]!.resolve();
    await pending[1];
    expect(started).toEqual(["0", "1", "3", "2"]);
    releases[3]!.resolve();
    await pending[3];
    expect(started).toEqual(["0", "1", "3", "2", "4"]);
    expect(maximum).toBe(2);
  } finally {
    for (const release of releases) {
      release.resolve();
    }
    await Promise.all(pending);
  }
  expect(active).toBe(0);
});

it("serves summary polls while full diff workers await untracked-file preparation", async ({
  signal,
}) => {
  const repo = tempDirs.make("openclaw-git-worker-summary-");
  await promisify(execFile)("git", ["init", "--template=", "--initial-branch=main"], {
    cwd: repo,
    env: createNestedGitEnv(),
  });
  await fs.writeFile(path.join(repo, "new.txt"), "new content\n");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const realMkdtemp = fs.mkdtemp;
  const contentWorkers = resolveWorkerPoolSize("reader");
  let held = 0;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    if (prefix.includes("openclaw-git-operation-") && held < contentWorkers) {
      if (++held === contentWorkers) {
        entered.resolve();
      }
      await release.promise;
    }
    return await realMkdtemp(prefix, options);
  });
  const pending = Array.from({ length: contentWorkers }, () =>
    runGitWorkerOperation({ type: "checkout.diff", input: { cwd: repo } }),
  );
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        Promise.all(pending),
        "Full diffs finished before untracked-file preparation was held",
      ),
      signal,
    );
    const summary = runGitWorkerOperation({
      type: "checkout.diff",
      input: { cwd: repo, summaryOnly: true },
    });
    pending.push(summary);
    const result = await withinTest(summary, signal);
    expect(result.files).toContainEqual({
      path: "new.txt",
      status: "added",
      untracked: true,
      additions: 1,
      deletions: 0,
    });
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
});

it("bounds content/removal through cancellation while metadata stays responsive", async ({
  signal,
}) => {
  const wait = <T>(promise: Promise<T>) => withinTest(promise, signal);
  const release = createDeferredCore();
  const firstStarted = createDeferredCore();
  const started: string[] = [];
  let active = 0;
  let maximum = 0;
  const result = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
    timeoutMs: 120_000,
    windowsEncoding: null,
  } satisfies Awaited<ReturnType<typeof runGitBytes>>;
  const run = async (cwd: string, _args: string[], options?: { lowerPriority?: boolean }) => {
    if (cwd === "metadata") {
      return result;
    }
    expect(options?.lowerPriority).toBe(true);
    started.push(cwd);
    maximum = Math.max(maximum, ++active);
    if (cwd === "diff" && active === 2) {
      firstStarted.resolve();
    }
    try {
      await release.promise;
      return result;
    } finally {
      active--;
    }
  };
  // Exercise host batch admission without starting a worker or child process.
  vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(async (request, options) => {
    const command = typeof request === "function" ? await request() : request;
    const input = asOptionalRecord(asOptionalRecord(command)?.input);
    const cwd = input?.cwd ?? input?.root ?? input?.repoRoot;
    const taskSignal = options.signal ?? new AbortController().signal;
    await options.onRequest!(
      {
        type: "git.batch",
        input: {
          requests: ["git.text", "git.buffer"].map((type) => ({
            type,
            input: { cwd, args: ["diff", "--shortstat"], options: {} },
          })),
        },
      },
      { signal: taskSignal, yieldSignal: taskSignal },
    );
    return { ok: true, value: undefined };
  });
  const gitCommands = { text: run, buffered: run };
  const operation = (
    command: Parameters<typeof runGitWorkerOperation>[0],
    taskSignal?: AbortSignal,
  ) => runGitWorkerOperation(command, { git: gitCommands, signal: taskSignal });
  const task = (...args: Parameters<typeof operation>) => settle(operation(...args));
  const abortRunning = new AbortController();
  const abortQueued = new AbortController();
  const abortRemoval = new AbortController();
  const firstSettled = vi.fn();
  const first = task(
    { type: "checkout.diff", input: { cwd: "diff", scope: "uncommitted" } },
    abortRunning.signal,
  ).finally(firstSettled);
  const pending: Promise<unknown>[] = [first];
  try {
    await wait(firstStarted.promise);
    const second = task({ type: "checkout.baseline", input: { cwd: "baseline" } });
    const queued = task(
      {
        type: "pull-request.branch-facts",
        input: {
          root: "canceled",
          branch: "main",
          mergedHeads: [],
          comparison: { statsBase: null, creatable: false, equalPushedTips: false, complete: true },
        },
      },
      abortQueued.signal,
    );
    const snapshot = task({
      type: "worktree.snapshot",
      input: {
        worktreeId: "snapshot",
        repoRoot: "snapshot",
        checkoutPath: "snapshot",
        reason: "fixture",
        provisionedPaths: [],
      },
    });
    const remove = (name: string, queueSignal?: AbortSignal) =>
      withWorktreeGitConfig(name, false, {}, (git) =>
        removeManagedCheckout(
          {
            id: name,
            name,
            repoFingerprint: "fixture",
            repoRoot: name,
            path: `${name}/checkout`,
            branch: `openclaw/${name}`,
            baseRef: "HEAD",
            ownerKind: "manual",
            createdAt: 1,
            lastActiveAt: 1,
          },
          {
            ...git,
            run: async (cwd, args, options) => ({
              ...(await run(cwd, args, options)),
              stdout: "",
              stderr: "",
            }),
          },
          // Keep this slot/cancellation test independent of checkout filesystem setup.
          true,
          "bounded",
          undefined,
          queueSignal,
        ),
      );
    const removal = remove("removal");
    const canceledRemoval = settle(remove("canceled-removal", abortRemoval.signal));
    pending.push(second, queued, snapshot, removal, canceledRemoval);
    await wait(operation({ type: "repository.branches", input: { repoRoot: "metadata" } }));
    expect(started).toEqual(["diff", "diff"]);
    abortQueued.abort();
    expect((await wait(queued)).rejected).toBe(true);
    const canceled = new Error("removal cancelled while queued");
    abortRemoval.abort(canceled);
    expect(await wait(canceledRemoval)).toEqual({ rejected: true, error: canceled });
    expect(started).toEqual(["diff", "diff"]);
    abortRunning.abort();
    expect(firstSettled).not.toHaveBeenCalled();
    expect(active).toBe(2);
    release.resolve();
    await Promise.all(pending);
    expect((await first).rejected).toBe(true);
    expect((await second).rejected).toBe(false);
    expect(started.slice(2).toSorted()).toEqual([
      "baseline",
      "baseline",
      "removal",
      "snapshot",
      "snapshot",
    ]);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
});
