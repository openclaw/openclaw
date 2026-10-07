import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import type { runGitBytes } from "../agents/worktrees/git.js";
import { removeManagedCheckout } from "../agents/worktrees/removal-git.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

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

it("bounds content, snapshot, and checkout removal through cancellation while metadata stays responsive", async ({
  signal,
}) => {
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
  vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(async (command, options) => {
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
  const abortRunning = new AbortController();
  const abortQueued = new AbortController();
  const abortRemoval = new AbortController();
  let firstSettled = false;
  const first = settle(
    runGitWorkerOperation(
      { type: "checkout.diff", input: { cwd: "diff", scope: "uncommitted" } },
      { git: gitCommands, signal: abortRunning.signal },
    ),
  ).then((value) => {
    firstSettled = true;
    return value;
  });
  const pending: Promise<unknown>[] = [first];
  try {
    await withinTest(firstStarted.promise, signal);
    const second = settle(
      runGitWorkerOperation(
        { type: "checkout.baseline", input: { cwd: "baseline" } },
        { git: gitCommands },
      ),
    );
    const queued = settle(
      runGitWorkerOperation(
        {
          type: "pull-request.branch-facts",
          input: { root: "canceled", branch: "main", mergedHeads: [] },
        },
        { git: gitCommands, signal: abortQueued.signal },
      ),
    );
    const snapshot = settle(
      runGitWorkerOperation(
        {
          type: "worktree.snapshot",
          input: {
            worktreeId: "snapshot",
            repoRoot: "snapshot",
            checkoutPath: "snapshot",
            reason: "fixture",
            provisionedPaths: [],
          },
        },
        { git: gitCommands },
      ),
    );
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
          false,
          "bounded",
          undefined,
          queueSignal,
        ),
      );
    const removal = remove("removal");
    const canceledRemoval = settle(remove("canceled-removal", abortRemoval.signal));
    pending.push(second, queued, snapshot, removal, canceledRemoval);
    await withinTest(
      runGitWorkerOperation(
        { type: "repository.branches", input: { repoRoot: "metadata" } },
        { git: gitCommands },
      ),
      signal,
    );
    expect(started).toEqual(["diff", "diff"]);
    abortQueued.abort();
    expect((await withinTest(queued, signal)).rejected).toBe(true);
    const canceled = new Error("removal cancelled while queued");
    abortRemoval.abort(canceled);
    expect(await withinTest(canceledRemoval, signal)).toEqual({
      rejected: true,
      error: canceled,
    });
    expect(started).toEqual(["diff", "diff"]);
    abortRunning.abort();
    expect(firstSettled).toBe(false);
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
