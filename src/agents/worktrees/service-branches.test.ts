import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
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
  InvalidWorktreeBaseRefError,
  resolveWorktreeBase,
  withWorktreeBasePreparation,
  type WorktreeBasePreparation,
} from "./base-ref.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

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

describe("ManagedWorktreeService branch discovery", () => {
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;

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
    root = tempDirs.make("openclaw-worktree-branches-", await fs.realpath(os.tmpdir()));
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
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
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
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=openclaw-test@example.invalid",
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
    { mode: "aborted", outcome: "settled" },
    { mode: "revoked", outcome: "settled" },
    { mode: "revoked", outcome: "uncertain-result" },
    { mode: "revoked", outcome: "uncertain-metadata" },
  ])(
    "settles shared default fetching after its owner is $mode ($outcome)",
    async ({ mode, outcome }, { signal }) => {
      await createRemote();
      const entered = createDeferred();
      const joined = createDeferred();
      const release = createDeferred();
      const controller = new AbortController();
      const failure = new Error("default lookup authority ended");
      const uncertain =
        outcome === "uncertain-metadata"
          ? recordCommandProcessFailure(new Error("fetch process settlement failed"), {
              pid: 123,
              code: null,
              cleanup: "uncertain",
              termination: "signal",
            })
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
      vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
        if (args[0] === "ls-remote") {
          discoveries++;
        }
        if (args[0] === "fetch" && ++fetches === 1) {
          entered.resolve();
          await release.promise;
          if (outcome === "uncertain-result") {
            return {
              stdout: "",
              stderr: "",
              code: null,
              signal: null,
              killed: false,
              termination: "signal",
              cleanup: "uncertain",
              timeoutMs: options?.timeoutMs ?? 60_000,
            };
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
        if (outcome === "settled") {
          expect(firstOutcome).toBe(failure);
          expect(secondOutcome).toBe(failure);
          expect({ discoveries, fetches }).toEqual({ discoveries: 1, fetches: 1 });
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
          expect({ discoveries, fetches }).toEqual({ discoveries: 1, fetches: 1 });
        }
      } finally {
        release.resolve();
        await Promise.allSettled([firstResult, secondResult]);
      }
    },
  );

  it.each([
    { offline: false, dirty: false, switching: false },
    { offline: true, dirty: true, switching: false },
    { offline: false, dirty: false, switching: true },
  ])(
    "uses the remote default and only advances clean local main ($offline, $dirty, switching: $switching)",
    async ({ offline, dirty, switching }) => {
      const localHead = await git(repo, "rev-parse", "HEAD");
      await fs.writeFile(path.join(repo, "README.md"), "remote update\n");
      await git(repo, "add", "README.md");
      const remoteTree = await git(repo, "write-tree");
      await fs.writeFile(path.join(repo, "README.md"), "base\n");
      await git(repo, "add", "README.md");
      const remoteHead = await createChildCommit(remoteTree);
      const remote = await createRemote();
      await git(repo, "fetch", "origin");
      await git(repo, "remote", "set-head", "origin", "-a");
      await git(remote, "update-ref", "refs/heads/main", remoteHead, localHead);

      const explicit = await service.create({
        repoRoot: repo,
        name: "local-base",
        baseRef: "main",
      });
      expect(await git(explicit.path, "rev-parse", "HEAD")).toBe(localHead);
      expect(await git(repo, "rev-parse", "origin/main")).toBe(localHead);

      if (offline) {
        // A project refresh has fetched new refs, but the worktree fetch cannot reach origin.
        await git(repo, "fetch", "origin");
        await git(repo, "remote", "set-url", "origin", path.join(root, "unavailable.git"));
      }

      if (!offline && !dirty) {
        // Background template prewarming selects the remote base without moving local main.
        expect((await resolveWorktreeBase(repo)).commit).toBe(remoteHead);
        expect(await git(repo, "rev-parse", "main")).toBe(localHead);
      }
      if (dirty) {
        await fs.writeFile(path.join(repo, "README.md"), "local work\n");
      }
      let switched = false;
      if (switching) {
        await git(repo, "branch", "feature");
        const readDirectory = fs.readdir;
        vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          const entries = await readDirectory(...args);
          if (!switched && args[0] === path.join(repo, ".git", "worktrees")) {
            switched = true;
            await git(repo, "switch", "feature");
          }
          return entries;
        });
      }
      const logs = createWarnLogCapture("worktree-base-fetch");
      try {
        const defaultBase = await service.create({ repoRoot: repo, name: "remote-base" });
        expect(defaultBase.baseRef).toBe("origin/main");
        expect(await git(defaultBase.path, "rev-parse", "HEAD")).toBe(remoteHead);
        expect(await fs.readFile(path.join(defaultBase.path, "README.md"), "utf8")).toBe(
          "remote update\n",
        );
        if (switching) {
          expect(switched).toBe(true);
          expect(
            await git(repo, "rev-parse", "feature"),
            "source branch must not be advanced",
          ).toBe(localHead);
        }
        expect(await git(repo, "rev-parse", "main")).toBe(
          dirty || switching ? localHead : remoteHead,
        );
        expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe(
          dirty ? "local work\n" : switching ? "base\n" : "remote update\n",
        );
        if (offline) {
          const warning = await logs.findText("worktree base origin/main");
          expect(warning).toContain(remoteHead);
          expect(warning).toContain("commit age");
          expect(warning).toContain("fetch failed");
          expect(warning).toContain("unavailable.git");
        }
      } finally {
        logs.cleanup();
      }
    },
  );

  it("discovers a renamed remote default without substituting local HEAD", async () => {
    useInProcessWorktreeCapacityTransport();
    const disk = fsSync.statfsSync(root);
    vi.spyOn(fsSync, "statfsSync").mockReturnValue({
      type: disk.type,
      files: disk.files,
      frsize: disk.frsize,
      ffree: disk.ffree,
      bsize: 4096,
      blocks: 1024 ** 4 / 4096,
      bavail: (100 * 1024 ** 3) / 4096,
      bfree: (100 * 1024 ** 3) / 4096,
    });
    const remote = await createRemote();
    await git(repo, "fetch", "origin");
    await git(repo, "remote", "set-head", "origin", "-a");
    const localHead = await git(repo, "rev-parse", "HEAD");
    await git(remote, "branch", "-m", "main", "next");
    await git(repo, "config", "fetch.prune", "true");
    await git(repo, "config", "remote.origin.followRemoteHEAD", "never");

    await expect(
      service.create({ repoRoot: repo, name: "explicit-base", baseRef: "origin/missing" }),
    ).rejects.toThrow(InvalidWorktreeBaseRefError);
    const created = await service.create({ repoRoot: repo, name: "default-base" });

    expect(created.baseRef).toBe("origin/next");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(localHead);
    expect(await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(
      "refs/remotes/origin/next",
    );
    expect(await git(repo, "branch", "--list", "openclaw/explicit-base")).toBe("");
    expect(await service.listRegistryRecords()).toEqual([created]);
  });

  it("preserves ignored local data when the remote starts tracking its path", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "local.txt\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore local data");
    const localHead = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "local.txt"), "remote content\n");
    await git(repo, "add", "-f", "local.txt");
    const tree = await git(repo, "write-tree");
    await git(repo, "rm", "--cached", "local.txt");
    await fs.writeFile(path.join(repo, "local.txt"), "local data\n");
    const remoteHead = await createChildCommit(tree, "track local path");
    await createRemote(remoteHead);
    const logs = createWarnLogCapture("worktree-base-ignored");
    try {
      const created = await service.create({ repoRoot: repo, name: "remote-data" });
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteHead);
      expect(await git(repo, "rev-parse", "HEAD")).toBe(localHead);
      expect(await fs.readFile(path.join(repo, "local.txt"), "utf8")).toBe("local data\n");
      expect(await logs.findText("git fast-forward local default")).toContain("local.txt");
    } finally {
      logs.cleanup();
    }
  });

  it("preserves local main held by an unavailable checkout", async () => {
    const localHead = await git(repo, "rev-parse", "HEAD");
    const remoteHead = await createChildCommit();
    await createRemote(remoteHead);
    const linked = path.join(root, "linked");
    await git(repo, "switch", "-c", "feature");
    await git(repo, "worktree", "add", linked, "main");
    await git(repo, "worktree", "lock", linked);
    await fs.rm(linked, { recursive: true, force: true });

    const created = await service.create({ repoRoot: repo, name: "remote-default" });
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(await git(repo, "rev-parse", "main")).toBe(localHead);
  });

  it("retains the default branch reserved by an attached update-refs rebase", async () => {
    await git(repo, "switch", "-c", "onto");
    await fs.writeFile(path.join(repo, "README.md"), "onto change\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "onto change");
    await git(repo, "switch", "main");
    await fs.writeFile(path.join(repo, "README.md"), "local change\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "local change");
    const localHead = await git(repo, "rev-parse", "HEAD");
    const remoteHead = await createChildCommit();
    await createRemote(remoteHead);
    const rebasing = path.join(root, "rebasing");
    await git(repo, "worktree", "add", "--force", rebasing, "main");
    await git(rebasing, "switch", "-c", "topic");
    // Git excludes checked-out branches when preparing its update-refs list.
    await git(repo, "switch", "onto");
    await fs.writeFile(path.join(rebasing, "topic.txt"), "topic\n");
    await git(rebasing, "add", "topic.txt");
    await git(rebasing, "commit", "-m", "topic tip");
    await expect(git(rebasing, "rebase", "--update-refs", "onto")).rejects.toMatchObject({
      code: 1,
    });
    const gitDir = await git(rebasing, "rev-parse", "--absolute-git-dir");
    expect(await fs.readFile(path.join(gitDir, "rebase-merge", "update-refs"), "utf8")).toContain(
      "refs/heads/main\n",
    );
    await git(repo, "switch", "--ignore-other-worktrees", "main");
    // A rebase exec or an operator can reattach HEAD while the rebase remains paused.
    await git(rebasing, "symbolic-ref", "HEAD", "refs/heads/topic");
    const pausedHead = await git(rebasing, "rev-parse", "HEAD");
    const pausedStatus = await git(rebasing, "status", "--porcelain");
    expect(pausedStatus).toContain("UU README.md");

    const created = await service.create({ repoRoot: repo, name: "during-rebase" });
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(await git(repo, "rev-parse", "main")).toBe(localHead);
    expect(await git(rebasing, "rev-parse", "HEAD")).toBe(pausedHead);
    expect(await git(rebasing, "status", "--porcelain")).toBe(pausedStatus);
  });

  it("retains main while a linked bisect reserves it", async () => {
    const good = await git(repo, "rev-parse", "HEAD");
    await git(repo, "commit", "--allow-empty", "-m", "middle");
    await git(repo, "commit", "--allow-empty", "-m", "bad");
    const localHead = await git(repo, "rev-parse", "HEAD");
    const remoteHead = await createChildCommit();
    await createRemote(remoteHead);
    const linked = path.join(root, "bisecting");
    await git(repo, "worktree", "add", "--force", linked, "main");
    await git(linked, "bisect", "start", localHead, good);
    const pausedHead = await git(linked, "rev-parse", "HEAD");
    const selected = await resolveWorktreeBase(
      repo,
      undefined,
      undefined,
      undefined,
      "fast-forward",
    );
    expect(selected.commit).toBe(remoteHead);
    expect(await git(repo, "rev-parse", "main")).toBe(localHead);
    expect(await git(linked, "rev-parse", "HEAD")).toBe(pausedHead);
  });

  it("reports Git, plain-directory, and unavailable repository status", async () => {
    const nested = path.join(repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await expect(
      service.listRepositoryBranches(nested, { includeRepositoryStatus: true }),
    ).resolves.toMatchObject({ repositoryStatus: "git" });

    const plain = path.join(root, "plain");
    await fs.mkdir(plain);
    await expect(
      service.listRepositoryBranches(plain, { includeRepositoryStatus: true }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "not_git" });
    await expect(service.listRepositoryBranches(plain)).rejects.toThrow("not a git checkout");

    const malformed = path.join(root, "malformed");
    await fs.mkdir(malformed);
    await fs.writeFile(path.join(malformed, ".git"), "not a gitdir pointer\n");
    await expect(
      service.listRepositoryBranches(malformed, { includeRepositoryStatus: true }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "unavailable" });
    await expect(
      service.listRepositoryBranches(path.join(root, "missing"), {
        includeRepositoryStatus: true,
      }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "unavailable" });

    const unborn = path.join(root, "unborn");
    await fs.mkdir(unborn);
    await git(unborn, "init", "-b", "main", `--template=${path.join(root, "git-template")}`);
    await expect(
      service.listRepositoryBranches(unborn, { includeRepositoryStatus: true }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "not_git" });
    await expect(service.listRepositoryBranches(unborn)).rejects.toThrow(
      "Create an initial commit, then retry.",
    );
    await expect(service.create({ repoRoot: unborn, name: "requires-commit" })).rejects.toThrow(
      "Create an initial commit, then retry.",
    );

    for (const ref of ["broken-ref\n", `${"a".repeat(40)}\n`]) {
      await fs.writeFile(path.join(unborn, ".git", "refs", "heads", "main"), ref);
      await expect(
        service.listRepositoryBranches(unborn, { includeRepositoryStatus: true }),
      ).resolves.toEqual({ branches: [], repositoryStatus: "unavailable" });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "lists branches when Windows Git emits MSYS paths and preserves HEAD^{commit}",
    async () => {
      const result = await service.listRepositoryBranches(repo);

      expect(result.headBranch).toBe("main");
      expect(result.branches).toContainEqual({ name: "main", kind: "local" });
    },
  );
});
