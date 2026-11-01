import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as gitExec from "../../infra/git-exec.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  CommandProcessCleanupError,
  readCommandProcessFailure,
  recordCommandProcessFailure,
} from "../../process/exec-result.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  resolveWorktreeBase,
  withWorktreeBasePreparation,
  type WorktreeBasePreparation,
} from "./base-ref.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import { git, gitIdentity } from "./git-fixture.test-support.js";
import * as preparation from "./service-preparation.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

const lookupTempDirs = useAutoCleanupTempDirTracker(afterEach);

function trackBaseLookupCallers(repo: string, count: number) {
  const current = new AsyncLocalStorage<number>();
  const seen = new Set<number>();
  const ready = createDeferred();
  const observe = () => {
    const caller = current.getStore();
    if (caller !== undefined) {
      seen.add(caller);
      if (seen.size === count) {
        ready.resolve();
      }
    }
  };
  const realpath = fs.realpath;
  vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
    const result = await realpath(...args);
    if (result === repo) {
      observe();
    }
    return result;
  });
  return {
    ready: ready.promise,
    run: <T>(index: number, run: () => T) => current.run(index, run),
    observeCommand: (args: string[]) => {
      // Uncoalesced implementations reach discovery without resolving a sharing key.
      if (args[0] === "symbolic-ref" && args[1] === "--quiet") {
        observe();
      }
    },
  };
}

describe("worktree default-base preparation", () => {
  let root: string;
  let repo: string;

  async function createRemote(mainCommit?: string) {
    const remote = path.join(root, "remote.git");
    await git(root, "clone", "--bare", repo, remote);
    if (mainCommit) {
      await git(remote, "update-ref", "refs/heads/main", mainCommit);
    }
    await git(repo, "remote", "add", "origin", remote);
    return remote;
  }

  async function createChildCommit(tree = "HEAD^{tree}", message = "remote update") {
    return await git(repo, "commit-tree", tree, "-p", "HEAD", "-m", message);
  }

  beforeEach(async () => {
    root = lookupTempDirs.make("openclaw-worktree-branches-", await fs.realpath(os.tmpdir()));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "global.gitconfig"));
    const template = path.join(root, "git-template");
    repo = path.join(root, "repo");
    await fs.mkdir(path.join(template, "hooks"), { recursive: true });
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main", `--template=${template}`);
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    setRuntimeConfigSnapshot({});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("coalesces default discovery and refreshes settled refs after their freshness window", async ({
    signal,
  }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const remote = await createRemote();
    const head = await git(repo, "rev-parse", "HEAD");
    const nested = path.join(repo, "nested");
    await fs.mkdir(nested);
    const callers = 40;
    const admission = trackBaseLookupCallers(repo, callers);
    const release = createDeferred();
    const execute = gitExec.executeGitCommand;
    let discoveries = 0;
    let fetches = 0;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      admission.observeCommand(args);
      if (args[0] === "ls-remote" && ++discoveries === 1) {
        await release.promise;
      }
      if (args[0] === "fetch") {
        fetches++;
      }
      return await execute(cwd, args, options);
    });
    const pending = Array.from({ length: callers }, (_, index) =>
      admission.run(index, () => resolveWorktreeBase(index % 2 ? `${nested}${path.sep}..` : repo)),
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          admission.ready,
          Promise.all(pending),
          "base lookup did not reach every caller",
        ),
        signal,
      );
      release.resolve();
      expect(await Promise.all(pending)).toMatchObject(
        Array.from({ length: callers }, () => ({
          commit: head,
          gitOperand: "refs/remotes/origin/main",
          recordRef: "origin/main",
          fetchSucceeded: true,
        })),
      );
      expect({ discoveries, fetches }).toEqual({ discoveries: 1, fetches: 1 });
      await expect(resolveWorktreeBase(repo, "main")).resolves.toMatchObject({ commit: head });
      expect({ discoveries, fetches }).toEqual({ discoveries: 1, fetches: 1 });

      const next = await git(
        remote,
        ...gitIdentity,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "next default",
      );
      await git(remote, "update-ref", "refs/heads/next", next);
      await git(remote, "symbolic-ref", "HEAD", "refs/heads/next");
      clock.mockReturnValue(now + 30_000);
      await expect(resolveWorktreeBase(repo)).resolves.toMatchObject({
        commit: next,
        recordRef: "origin/next",
      });
      expect({ discoveries, fetches }).toEqual({ discoveries: 2, fetches: 2 });
      expect(await git(repo, "rev-parse", "main")).toBe(head);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("closes an unused base preparation without allowing later Git effects", async () => {
    let expired: WorktreeBasePreparation | undefined;
    const execute = vi.spyOn(gitExec, "executeGitCommand");
    await withWorktreeBasePreparation(
      { repoRoot: repo, commonDir: path.join(repo, ".git") },
      async (resolve) => {
        expired = resolve;
      },
    );
    await expect(expired!({})).rejects.toThrow("Worktree base preparation is closed");
    expect(execute).not.toHaveBeenCalled();
  });

  it.for([
    ...["aborted", "revoked"].flatMap((mode) =>
      [
        "settled",
        "uncertain-result",
        "uncertain-error",
        "uncertain-metadata",
        "outcome-unknown",
      ].map((outcome) => ({ mode, outcome, command: "fetch" })),
    ),
    { mode: "active", outcome: "uncertain-result", command: "fetch" },
    { mode: "active", outcome: "failed", command: "fetch" },
    { mode: "aborted", outcome: "failed", command: "fetch" },
    { mode: "aborted", outcome: "uncertain-result", command: "ls-remote" },
    { mode: "aborted", outcome: "uncertain-result", command: "symbolic-ref" },
    { mode: "aborted", outcome: "cancelled-result", command: "remote" },
    { mode: "aborted", outcome: "cancelled-result", command: "update-head" },
    { mode: "aborted", outcome: "cancelled-result", command: "verify" },
    { mode: "aborted", outcome: "uncertain-result", command: "remote" },
    { mode: "aborted", outcome: "cancelled-result", command: "config" },
    { mode: "aborted", outcome: "uncertain-result", command: "config" },
    { mode: "aborted", outcome: "uncertain-result", command: "verify" },
    { mode: "aborted", outcome: "exit-failure", command: "remote" },
    { mode: "aborted", outcome: "output-limit", command: "remote" },
    { mode: "aborted", outcome: "exit-failure", command: "fetch" },
    { mode: "aborted", outcome: "output-limit", command: "fetch" },
    { mode: "aborted", outcome: "exit-failure", command: "ls-remote" },
    { mode: "aborted", outcome: "cancelled-before-spawn", command: "remote" },
    { mode: "aborted", outcome: "cancelled-before-spawn", command: "fetch" },
  ])(
    "settles shared default fetching after its owner is $mode ($command, $outcome)",
    async ({ mode, outcome, command }, { signal }) => {
      await createRemote();
      const entered = createDeferred();
      const joined = createDeferred();
      const release = createDeferred();
      const controller = new AbortController();
      const failure = new Error("default lookup authority ended");
      const fetchFailure = new Error("settled Git failure");
      const uncertain =
        outcome === "uncertain-metadata"
          ? recordCommandProcessFailure(new Error("fetch process settlement failed"), {
              pid: 123,
              code: null,
              cleanup: "uncertain",
              termination: "signal",
            })
          : outcome === "outcome-unknown"
            ? new SqliteWorkerError("fetch owner outcome unknown", "outcome-unknown")
            : new CommandProcessCleanupError();
      let revoked = false;
      const assertCurrent = () => {
        if (revoked) {
          throw failure;
        }
      };
      const execute = gitExec.executeGitCommand;
      let discoveries = 0;
      let fetches = 0;
      let gated = false;
      const failedCounts = {
        discoveries: ["remote", "config", "symbolic-ref"].includes(command) ? 0 : 1,
        fetches: ["fetch", "update-head", "verify"].includes(command) ? 1 : 0,
      };
      vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
        if (args[0] === "ls-remote") {
          discoveries++;
        }
        if (args[0] === "fetch") {
          fetches++;
        }
        const selectedCommand =
          command === "update-head"
            ? args[0] === "symbolic-ref" && args.length === 3 && !args[1]!.startsWith("-")
            : command === "verify"
              ? args[0] === "rev-parse" && args[2]?.startsWith("refs/remotes/origin/")
              : args[0] === command;
        if (selectedCommand && !gated) {
          gated = true;
          entered.resolve();
          await release.promise;
          if (
            [
              "uncertain-result",
              "cancelled-result",
              "cancelled-before-spawn",
              "exit-failure",
              "output-limit",
            ].includes(outcome)
          ) {
            return {
              stdout: "",
              stderr: "",
              code: outcome === "exit-failure" ? 1 : null,
              signal: null,
              killed: false,
              termination: outcome === "exit-failure" ? "exit" : "signal",
              cleanup:
                outcome === "uncertain-result"
                  ? "uncertain"
                  : outcome === "cancelled-before-spawn"
                    ? "normal"
                    : "cooperative",
              killIssuedByAbort: ["cancelled-result", "output-limit"].includes(outcome),
              outputLimitExceeded: outcome === "output-limit",
              timeoutMs: options?.timeoutMs ?? 60_000,
            };
          }
          if (outcome === "failed") {
            throw fetchFailure;
          }
          if (outcome !== "settled") {
            throw uncertain;
          }
        }
        return await execute(cwd, args, options);
      });
      const first = resolveWorktreeBase(repo, undefined, controller.signal, assertCurrent);
      const firstResult = first.catch((error: unknown) => error);
      let second: ReturnType<typeof resolveWorktreeBase> | undefined;
      let secondResult: Promise<unknown> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, first, "first fetch did not start"),
          signal,
        );
        second = withWorktreeBasePreparation(
          { repoRoot: repo, commonDir: path.join(repo, ".git") },
          (resolve) => {
            joined.resolve();
            return resolve({});
          },
        );
        secondResult = second.catch((error: unknown) => error);
        await withinTest(
          awaitGateBeforeSettlement(joined.promise, second, "second lookup did not join"),
          signal,
        );
        if (mode === "aborted") {
          controller.abort(failure);
        } else if (mode === "revoked") {
          revoked = true;
        }
        release.resolve();
        const [firstOutcome, secondOutcome] = await withinTest(
          Promise.all([firstResult, secondResult]),
          signal,
        );
        if (["settled", "cancelled-result", "cancelled-before-spawn"].includes(outcome)) {
          expect(firstOutcome).toBeInstanceOf(Error);
          if (outcome === "settled") {
            expect(firstOutcome).toBe(failure);
          }
          expect(secondOutcome).toMatchObject({
            commit: await git(repo, "rev-parse", "HEAD"),
            recordRef: "origin/main",
            fetchSucceeded: true,
          });
          expect({ discoveries, fetches }).toEqual({
            discoveries: failedCounts.discoveries + 1,
            fetches: failedCounts.fetches + 1,
          });
        } else if (outcome === "exit-failure" || outcome === "output-limit") {
          expect(firstOutcome).toBeInstanceOf(Error);
          expect(secondOutcome).toBe(firstOutcome);
          expect({ discoveries, fetches }).toEqual(failedCounts);
        } else if (outcome === "failed") {
          expect(firstOutcome).toBe(fetchFailure);
          expect(secondOutcome).toBe(fetchFailure);
          expect({ discoveries, fetches }).toEqual(failedCounts);
        } else {
          expect(hasWorktreeUnknownOutcome(firstOutcome)).toBe(true);
          expect(hasWorktreeUnknownOutcome(secondOutcome)).toBe(true);
          if (outcome === "uncertain-metadata") {
            expect(firstOutcome).toMatchObject({ cause: uncertain });
            expect(readCommandProcessFailure(firstOutcome)).toEqual(
              readCommandProcessFailure(uncertain),
            );
          } else if (outcome !== "uncertain-result") {
            expect(firstOutcome).toBe(uncertain);
          }
          expect({ discoveries, fetches }).toEqual(failedCounts);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([firstResult, secondResult]);
      }
    },
  );

  it("bounds a recovering follower without cancelling the replacement owner", async ({
    signal,
  }) => {
    await createRemote();
    const repository = { repoRoot: repo, commonDir: path.join(repo, ".git") };
    const owner = new AbortController();
    const deadline = new AbortController();
    const expired = new Error("creation waiting budget expired");
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 10 ? deadline.signal : timeout(ms),
    );
    const entered = createDeferred();
    const release = createDeferred();
    const replacementEntered = createDeferred();
    const releaseReplacement = createDeferred();
    const execute = gitExec.executeGitCommand;
    let fetches = 0;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await execute(cwd, args, options);
      if (args[0] === "fetch") {
        if (++fetches === 1) {
          entered.resolve();
          await release.promise;
        } else {
          replacementEntered.resolve();
          await releaseReplacement.promise;
        }
      }
      return result;
    });
    const first = resolveWorktreeBase(repo, undefined, owner.signal).catch(
      (error: unknown) => error,
    );
    const pending: Promise<unknown>[] = [first];
    try {
      await withinTest(entered.promise, signal);
      const replacement = withWorktreeBasePreparation(repository, (resolve) => resolve({}));
      pending.push(replacement);
      const follower = withWorktreeBasePreparation(repository, (resolve) =>
        resolve({ waitBudget: { remainingMs: 10 } }),
      ).catch((error: unknown) => error);
      pending.push(follower);
      owner.abort(new Error("first owner cancelled"));
      release.resolve();
      await withinTest(replacementEntered.promise, signal);
      deadline.abort(expired);
      expect(await withinTest(follower, signal)).toBe(expired);
      expect(fetches).toBe(2);
      releaseReplacement.resolve();
      await expect(replacement).resolves.toMatchObject({
        commit: await git(repo, "rev-parse", "HEAD"),
        fetchSucceeded: true,
      });
      expect(fetches).toBe(2);
    } finally {
      release.resolve();
      releaseReplacement.resolve();
      await Promise.allSettled(pending);
    }
  });

  it.for(["survivors", "late", "follower", "all", "closed", "budget"] as const)(
    "retains consumer authority while recovering a settled default attempt (%s)",
    async (mode, { signal }) => {
      const localHead = await git(repo, "rev-parse", "HEAD");
      const remoteHead = await createChildCommit();
      await createRemote(remoteHead);
      const entered = createDeferred();
      const release = createDeferred();
      const releaseLate = createDeferred();
      const owner = new AbortController();
      const follower = new AbortController();
      const failure = new Error("consumer cancelled");
      const repository = { repoRoot: repo, commonDir: path.join(repo, ".git") };
      const execute = gitExec.executeGitCommand;
      let discoveries = 0;
      let fetches = 0;
      let activeFetches = 0;
      let maxActiveFetches = 0;
      let forwards = 0;
      vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
        discoveries += Number(args[0] === "ls-remote");
        forwards += Number(args[0] === "merge");
        if (args[0] !== "fetch") {
          return await execute(cwd, args, options);
        }
        const first = ++fetches === 1;
        maxActiveFetches = Math.max(maxActiveFetches, ++activeFetches);
        try {
          // Complete a real fetch before cancellation. Its settled result still
          // belongs to the first consumer until the production boundary consumes it.
          const result = await execute(cwd, args, options);
          if (first) {
            entered.resolve();
            await release.promise;
          }
          return result;
        } finally {
          activeFetches--;
        }
      });
      let firstResult: Promise<unknown> | undefined;
      const first = withWorktreeBasePreparation(repository, async (resolve) => {
        firstResult = resolve({ signal: owner.signal, localDefault: "fast-forward" }).catch(
          (error: unknown) => error,
        );
        if (mode === "closed") {
          // Return without borrowing the pending result: the scope closes while
          // its finally still joins the physical attempt's settlement.
          await entered.promise;
          return undefined;
        }
        return await firstResult;
      });
      const pending: Promise<unknown>[] = [first];
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, first, "first fetch did not start"),
          signal,
        );
        const joined = Array.from({ length: mode === "survivors" ? 8 : 1 }, () =>
          withWorktreeBasePreparation(repository, async (resolve) => {
            if (mode === "late") {
              await releaseLate.promise;
            }
            return await resolve({
              signal: follower.signal,
              waitBudget: { remainingMs: mode === "budget" ? 0 : 30_000 },
            });
          }).catch((error: unknown) => error),
        );
        pending.push(...joined);
        if (mode === "follower" || mode === "all") {
          follower.abort(failure);
        }
        if (mode !== "follower" && mode !== "closed") {
          owner.abort(failure);
        }
        release.resolve();
        const firstOutcome = await withinTest(firstResult!, signal);
        releaseLate.resolve();
        const outcomes = await withinTest(Promise.all(joined), signal);
        if (mode === "follower") {
          expect(firstOutcome).toMatchObject({ commit: remoteHead });
          expect(outcomes).toEqual([failure]);
        } else {
          if (mode === "closed") {
            expect(firstOutcome).toMatchObject({ message: "Worktree base preparation is closed" });
          } else {
            expect(firstOutcome).toBe(failure);
          }
          if (mode === "all") {
            expect(outcomes).toEqual([failure]);
          } else if (mode === "budget") {
            expect(outcomes[0]).toMatchObject({
              message:
                "Workspace creation timed out waiting for repository preparation. Retry creating the workspace.",
            });
          } else {
            expect(outcomes).toEqual(
              joined.map(() =>
                expect.objectContaining({ commit: remoteHead, fetchSucceeded: true }),
              ),
            );
          }
        }
        const attempts = ["follower", "all", "budget"].includes(mode) ? 1 : 2;
        expect({ discoveries, fetches, maxActiveFetches }).toEqual({
          discoveries: attempts,
          fetches: attempts,
          maxActiveFetches: 1,
        });
        // Surviving preserve-only consumers never inherit the retired owner's
        // permission to fast-forward the source checkout.
        expect(forwards).toBe(mode === "follower" ? 1 : 0);
        expect(await git(repo, "rev-parse", "main")).toBe(
          mode === "follower" ? remoteHead : localHead,
        );
      } finally {
        release.resolve();
        releaseLate.resolve();
        await Promise.allSettled(pending);
      }
    },
  );
});

describe("managed worktree creation groups", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useWorktreeStateRoots();
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;

  const create = (name: string) => service.create({ repoRoot: repo, name });
  const head = (cwd: string) => git(cwd, "rev-parse", "HEAD");
  function joinAllocations(count: number) {
    const allocate = preparation.createWithWorktreeAllocation;
    const joined = createDeferred();
    let callers = 0;
    vi.spyOn(preparation, "createWithWorktreeAllocation").mockImplementation(async (...args) => {
      if (++callers === count) {
        joined.resolve();
      }
      await joined.promise;
      return await allocate(...args);
    });
  }
  function observeReads() {
    const execute = gitExec.executeGitCommand;
    const counts = { fetches: 0, statusReads: 0 };
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "fetch") {
        counts.fetches++;
      }
      if (args[0] === "status" && path.resolve(cwd) === path.resolve(repo)) {
        counts.statusReads++;
      }
      return await execute(cwd, args, options);
    });
    return counts;
  }
  async function advanceRemote() {
    const remote = path.join(root, "remote.git");
    const args = ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "remote update"];
    const commit = await git(remote, ...gitIdentity, ...args);
    await git(remote, "update-ref", "refs/heads/main", commit);
    return commit;
  }

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worktree-creation-group-");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "global.gitconfig"));
    repo = await initializeRepository(root);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      getConfig: () => ({}),
    });
  });

  it.each(["branch", "detached", "inherited origin options"])(
    "creates from local HEAD without origin on a %s checkout",
    async (checkout) => {
      const originalHead = await head(repo);
      await git(repo, "remote", "remove", "origin");
      if (checkout === "inherited origin options") {
        await fs.writeFile(
          path.join(root, "global.gitconfig"),
          '[remote "origin"]\n\tprune = true\n',
        );
      }
      await git(repo, "switch", "-c", "local-work");
      await fs.writeFile(path.join(repo, "README.md"), "local commit\n");
      await git(repo, "add", "README.md");
      await git(repo, ...gitIdentity, "commit", "-m", "local work");
      const expectedHead = await head(repo);
      if (checkout === "detached") {
        await git(repo, "checkout", "--detach", expectedHead);
      }
      if (checkout === "inherited origin options") {
        await fs.writeFile(path.join(repo, "staged.txt"), "staged work\n");
        await git(repo, "add", "staged.txt");
        await fs.writeFile(path.join(repo, "README.md"), "unsaved work\n");
        await fs.writeFile(path.join(repo, "untracked.txt"), "untracked work\n");
      }
      const status = await git(repo, "status", "--porcelain");
      joinAllocations(2);
      const execute = gitExec.executeGitCommand;
      const remoteCommands: string[] = [];
      vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
        if (
          ["remote", "ls-remote", "fetch", "merge"].includes(args[0]!) &&
          args[1] !== "--get-url"
        ) {
          remoteCommands.push(args[0]!);
        }
        return await execute(cwd, args, options);
      });

      const records = await Promise.all([create("local-first"), create("local-second")]);

      for (const record of records) {
        expect(record.baseRef).toBe("HEAD");
        expect(await head(record.path)).toBe(expectedHead);
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe(
          "local commit\n",
        );
      }
      expect(await head(repo)).toBe(expectedHead);
      expect(await git(repo, "status", "--porcelain")).toBe(status);
      if (checkout === "inherited origin options") {
        expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe("unsaved work\n");
        expect(await fs.readFile(path.join(repo, "staged.txt"), "utf8")).toBe("staged work\n");
        expect(await fs.readFile(path.join(repo, "untracked.txt"), "utf8")).toBe(
          "untracked work\n",
        );
        const explicit = await service.create({
          repoRoot: repo,
          name: "explicit",
          baseRef: "main",
        });
        expect(await head(explicit.path)).toBe(originalHead);
      }
      expect(remoteCommands).toEqual(["remote"]);
    },
  );

  it.each(["inherited URL", "relative URL", "legacy", "implicit path", "implicit rewrite"])(
    "retains Git's origin destination from %s",
    async (destination) => {
      const expectedHead = await advanceRemote();
      await git(repo, "remote", "remove", "origin");
      await fs.writeFile(path.join(root, "global.gitconfig"), '[remote "origin"]\nprune = true\n');
      if (destination === "inherited URL") {
        await git(repo, "config", "--global", "remote.origin.url", "../remote.git");
      } else if (destination === "relative URL" || destination === "implicit path") {
        await fs.rename(path.join(root, "remote.git"), path.join(repo, "origin"));
        if (destination === "relative URL") {
          await git(repo, "config", "remote.origin.url", "origin");
        }
      } else if (destination === "implicit rewrite") {
        await git(repo, "config", "url.../remote.git.insteadOf", "origin");
      } else {
        await fs.mkdir(path.join(repo, ".git", "remotes"));
        await fs.writeFile(path.join(repo, ".git", "remotes", "origin"), "URL: ../remote.git\n");
      }

      const created = await create("git-origin");

      expect(created.baseRef).toBe("origin/main");
      expect(await head(created.path)).toBe(expectedHead);
    },
  );

  it("shares one dirty local-default decision across a burst of twenty creates", async () => {
    const localHead = await head(repo);
    const remoteHead = await advanceRemote();
    await fs.writeFile(path.join(repo, "README.md"), "local work\n");
    joinAllocations(20);
    const reads = observeReads();
    const enqueue = gitExec.enqueueGitRefMutation;
    const failures: unknown[] = [];
    vi.spyOn(gitExec, "enqueueGitRefMutation").mockImplementation(async (...args) => {
      try {
        return await enqueue(...args);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    });

    const records = await Promise.all(
      Array.from({ length: 20 }, (_, index) => create(`burst-${index}`)),
    );

    expect(new Set(records.map((record) => record.baseRef))).toEqual(new Set(["origin/main"]));
    expect(await head(repo)).toBe(localHead);
    expect(await git(repo, "rev-parse", "origin/main")).toBe(remoteHead);
    expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe("local work\n");
    expect(failures).toEqual([]);
    expect(reads).toEqual({ fetches: 1, statusReads: 1 });
  });

  it("shares a prepared default past fetch settlement", async ({ signal }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const expectedHead = await head(repo);
    const secondAdmitted = createDeferred();
    const releaseSecond = createDeferred();
    const allocate = preparation.createWithWorktreeAllocation;
    const caller = new AsyncLocalStorage<"first" | "second">();
    vi.spyOn(preparation, "createWithWorktreeAllocation").mockImplementation(async (...args) => {
      if (caller.getStore() === "first") {
        await secondAdmitted.promise;
      } else if (caller.getStore() === "second") {
        secondAdmitted.resolve();
        await releaseSecond.promise;
      }
      return await allocate(...args);
    });
    const reads = observeReads();
    const first = caller.run("first", () => create("cohort-first"));
    const second = caller.run("second", () => create("cohort-second"));
    try {
      await withinTest(
        awaitGateBeforeSettlement(secondAdmitted.promise, first, "second creator not admitted"),
        signal,
      );
      const createdFirst = await withinTest(first, signal);
      expect(reads.fetches).toBe(1);
      const late = await create("cohort-late");
      expect(await head(late.path)).toBe(expectedHead);
      expect(reads.fetches).toBe(1);
      // An overlapping creation must not extend the freshness window indefinitely.
      clock.mockReturnValue(now + 30_000);
      await create("cohort-expired");
      expect(reads.fetches).toBe(2);
      releaseSecond.resolve();
      const createdSecond = await withinTest(second, signal);
      expect(reads.fetches).toBe(2);
      expect(await head(createdFirst.path)).toBe(expectedHead);
      expect(await head(createdSecond.path)).toBe(expectedHead);
      expect(
        await git(createdSecond.path, "rev-parse", "--symbolic-full-name", "@{upstream}"),
      ).toBe("refs/remotes/origin/main");
      const repeated = await create("cohort-second");
      expect(repeated.id).toBe(createdSecond.id);
      expect(reads.fetches).toBe(2);
      await create("cohort-fresh");
      expect(reads.fetches).toBe(2);
    } finally {
      secondAdmitted.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("reports repository updates only while fetching the default base", async () => {
    const execute = gitExec.executeGitCommand;
    const events: string[] = [];
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "fetch") {
        events.push("fetch");
      }
      return await execute(cwd, args, options);
    });
    const onProgress = (phase: string) => events.push(phase);
    await service.create({ repoRoot: repo, name: "default", onProgress });
    expect(events.slice(0, 2)).toEqual(["base", "fetch"]);
    expect(events.at(-1)).toBe("checkout");
    events.length = 0;
    await service.create({ repoRoot: repo, name: "explicit", baseRef: "HEAD", onProgress });
    expect(events).toEqual(["checkout"]);
  });

  it("reuses a recent default, then refreshes after its freshness window", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const original = await create("original");
    const oldHead = await head(original.path);
    const newHead = await advanceRemote();
    clock.mockReturnValue(now + 29_000);
    const recent = await create("recent");
    expect(await head(recent.path)).toBe(oldHead);
    clock.mockReturnValue(now + 30_000);
    const refreshed = await create("refreshed");
    expect(await head(refreshed.path)).toBe(newHead);
  });
});
