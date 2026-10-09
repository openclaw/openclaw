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
import * as gitExec from "../../infra/git-exec.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import {
  CommandProcessCleanupError,
  readCommandProcessFailure,
  recordCommandProcessFailure,
} from "../../process/exec-result.js";
import * as execRunner from "../../process/exec-runner.js";
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
import * as preparation from "./service-preparation.js";
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
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("coalesces concurrent default discovery and fetch without retaining settled refs", async ({
    signal,
  }) => {
    const remote = path.join(root, "remote.git");
    await git(root, "clone", "--bare", repo, remote);
    await git(repo, "remote", "add", "origin", remote);
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
      expect(await Promise.all(pending)).toEqual(
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

  it("shares a prepared default with creators queued past its fetch settlement", async ({
    signal,
  }) => {
    const remote = path.join(root, "remote.git");
    await git(root, "clone", "--bare", repo, remote);
    await git(repo, "remote", "add", "origin", remote);
    const head = await git(repo, "rev-parse", "HEAD");
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
    const execute = gitExec.executeGitCommand;
    let fetches = 0;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "fetch") {
        fetches++;
      }
      return await execute(cwd, args, options);
    });
    const first = caller.run("first", () =>
      service.create({ repoRoot: repo, name: "cohort-first" }),
    );
    const second = caller.run("second", () =>
      service.create({ repoRoot: repo, name: "cohort-second" }),
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          secondAdmitted.promise,
          first,
          "second creator did not reach allocation",
        ),
        signal,
      );
      const createdFirst = await withinTest(first, signal);
      expect(fetches).toBe(1);
      releaseSecond.resolve();
      const createdSecond = await withinTest(second, signal);
      expect(fetches).toBe(1);
      expect(await git(createdFirst.path, "rev-parse", "HEAD")).toBe(head);
      expect(await git(createdSecond.path, "rev-parse", "HEAD")).toBe(head);
      expect(
        await git(createdSecond.path, "rev-parse", "--symbolic-full-name", "@{upstream}"),
      ).toBe("refs/remotes/origin/main");
      const repeated = await service.create({ repoRoot: repo, name: "cohort-second" });
      expect(repeated.id).toBe(createdSecond.id);
      expect(fetches).toBe(1);
      await service.create({ repoRoot: repo, name: "cohort-fresh" });
      expect(fetches).toBe(2);
    } finally {
      secondAdmitted.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it.for([
    ...["aborted", "revoked"].flatMap((mode) =>
      [
        "settled",
        "uncertain-result",
        "uncertain-error",
        "uncertain-metadata",
        "outcome-unknown",
      ].map((outcome) => ({ mode, outcome })),
    ),
    { mode: "active", outcome: "uncertain-result" },
  ])(
    "settles shared default fetching after its owner is $mode ($outcome)",
    async ({ mode, outcome }, { signal }) => {
      const remote = path.join(root, "remote.git");
      await git(root, "clone", "--bare", repo, remote);
      await git(repo, "remote", "add", "origin", remote);
      const head = await git(repo, "rev-parse", "HEAD");
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
          expect(secondOutcome).toMatchObject({ commit: head, fetchSucceeded: true });
          expect({ discoveries, fetches }).toEqual({ discoveries: 2, fetches: 2 });
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
    { offline: true, dirty: false, switching: false },
    { offline: false, dirty: true, switching: false },
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
      const remoteHead = await git(
        repo,
        "commit-tree",
        remoteTree,
        "-p",
        "HEAD",
        "-m",
        "remote update",
      );
      const remote = path.join(root, "remote.git");
      await git(root, "clone", "--bare", repo, remote);
      await git(repo, "remote", "add", "origin", remote);
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
    const remote = path.join(root, "remote.git");
    await git(root, "clone", "--bare", repo, remote);
    await git(repo, "remote", "add", "origin", remote);
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

  it("warns when the fetched default commit is more than seven days old", async () => {
    const timestamp = Number(await git(repo, "show", "-s", "--format=%ct", "HEAD"));
    const remote = path.join(root, "remote.git");
    await git(root, "clone", "--bare", repo, remote);
    await git(repo, "remote", "add", "origin", remote);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      now: () => (timestamp + 8 * 86_400) * 1000,
    });
    const logs = createWarnLogCapture("worktree-base-age");
    try {
      await service.create({ repoRoot: repo, name: "old-default" });
      const warning = await logs.findText("worktree base origin/main");
      expect(warning).toContain("commit age 8.0 days; fetch succeeded");
      expect(warning).toContain("base is older than 7 days");
    } finally {
      logs.cleanup();
    }
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
    const remoteHead = await git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "track local path");
    const remote = path.join(root, "remote.git");
    await git(root, "clone", "--bare", repo, remote);
    await git(remote, "update-ref", "refs/heads/main", remoteHead);
    await git(repo, "remote", "add", "origin", remote);
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

  it.each(["unavailable", "shared-dirty"])(
    "preserves local main held by a %s checkout",
    async (kind) => {
      const localHead = await git(repo, "rev-parse", "HEAD");
      const remoteHead = await git(
        repo,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "remote update",
      );
      const remote = path.join(root, "remote.git");
      await git(root, "clone", "--bare", repo, remote);
      await git(remote, "update-ref", "refs/heads/main", remoteHead);
      await git(repo, "remote", "add", "origin", remote);
      const linked = path.join(root, "linked");
      if (kind === "unavailable") {
        await git(repo, "switch", "-c", "feature");
        await git(repo, "worktree", "add", linked, "main");
        await git(repo, "worktree", "lock", linked);
        await fs.rm(linked, { recursive: true, force: true });
      } else {
        await git(repo, "worktree", "add", "--force", linked, "main");
        await fs.writeFile(path.join(linked, "README.md"), "local work\n");
      }

      const created = await service.create({ repoRoot: repo, name: "remote-default" });
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteHead);
      expect(await git(repo, "rev-parse", "main")).toBe(localHead);
      if (kind === "shared-dirty") {
        expect(await git(linked, "rev-parse", "HEAD")).toBe(localHead);
        expect(await fs.readFile(path.join(linked, "README.md"), "utf8")).toBe("local work\n");
      }
    },
  );

  it.each(["primary", "main", "unrelated", "update-refs", "attached-update-refs"])(
    "only retains the default branch reserved by a rebase (%s)",
    async (kind) => {
      const linked = kind !== "primary";
      await git(repo, "switch", "-c", "onto");
      await fs.writeFile(path.join(repo, "README.md"), "onto change\n");
      await git(repo, "add", "README.md");
      await git(repo, "commit", "-m", "onto change");
      await git(repo, "switch", "main");
      await fs.writeFile(path.join(repo, "README.md"), "local change\n");
      await git(repo, "add", "README.md");
      await git(repo, "commit", "-m", "local change");
      const localHead = await git(repo, "rev-parse", "HEAD");
      const remoteHead = await git(
        repo,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "remote update",
      );
      const remote = path.join(root, "remote.git");
      await git(root, "clone", "--bare", repo, remote);
      await git(remote, "update-ref", "refs/heads/main", remoteHead);
      await git(repo, "remote", "add", "origin", remote);
      const rebasing = linked ? path.join(root, "rebasing") : repo;
      if (linked) {
        await git(repo, "worktree", "add", "--force", rebasing, "main");
        if (kind !== "main") {
          await git(rebasing, "switch", "-c", "topic");
        }
      }
      const updateRefs = kind.endsWith("update-refs");
      if (updateRefs) {
        // Git excludes checked-out branches when preparing its update-refs list.
        await git(repo, "switch", "onto");
        await fs.writeFile(path.join(rebasing, "topic.txt"), "topic\n");
        await git(rebasing, "add", "topic.txt");
        await git(rebasing, "commit", "-m", "topic tip");
      }
      await expect(
        git(rebasing, "rebase", ...(updateRefs ? ["--update-refs"] : []), "onto"),
      ).rejects.toMatchObject({ code: 1 });
      if (updateRefs) {
        const gitDir = await git(rebasing, "rev-parse", "--absolute-git-dir");
        expect(
          await fs.readFile(path.join(gitDir, "rebase-merge", "update-refs"), "utf8"),
        ).toContain("refs/heads/main\n");
        await git(repo, "switch", "--ignore-other-worktrees", "main");
        if (kind === "attached-update-refs") {
          // A rebase exec or an operator can reattach HEAD while the rebase remains paused.
          await git(rebasing, "symbolic-ref", "HEAD", "refs/heads/topic");
        }
      }
      const pausedHead = await git(rebasing, "rev-parse", "HEAD");
      const pausedStatus = await git(rebasing, "status", "--porcelain");
      expect(pausedStatus).toContain("UU README.md");

      const created = await service.create({ repoRoot: repo, name: "during-rebase" });
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteHead);
      expect(await git(repo, "rev-parse", "main")).toBe(
        kind === "unrelated" ? remoteHead : localHead,
      );
      expect(await git(rebasing, "rev-parse", "HEAD")).toBe(pausedHead);
      expect(await git(rebasing, "status", "--porcelain")).toBe(pausedStatus);
    },
  );

  it.each(["main", "topic"])(
    "only retains the branch reserved by a linked bisect (%s)",
    async (branch) => {
      const good = await git(repo, "rev-parse", "HEAD");
      await git(repo, "commit", "--allow-empty", "-m", "middle");
      await git(repo, "commit", "--allow-empty", "-m", "bad");
      const localHead = await git(repo, "rev-parse", "HEAD");
      const remoteHead = await git(
        repo,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "remote update",
      );
      const remote = path.join(root, "remote.git");
      await git(root, "clone", "--bare", repo, remote);
      await git(remote, "update-ref", "refs/heads/main", remoteHead);
      await git(repo, "remote", "add", "origin", remote);
      const linked = path.join(root, "bisecting");
      if (branch === "topic") {
        await git(repo, "branch", "topic");
      }
      await git(repo, "worktree", "add", "--force", linked, branch);
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
      expect(await git(repo, "rev-parse", "main")).toBe(branch === "main" ? localHead : remoteHead);
      expect(await git(linked, "rev-parse", "HEAD")).toBe(pausedHead);
    },
  );

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

  it.each([false, true])(
    "reads the selected linked checkout's HEAD (detached: %s)",
    async (detached) => {
      const linked = path.join(root, "linked");
      await git(repo, "worktree", "add", "-b", "selected-work", linked, "HEAD");
      if (detached) {
        await git(linked, "switch", "--detach");
      }
      const nested = path.join(linked, "packages", "app");
      await fs.mkdir(nested, { recursive: true });

      for (const includeRepositoryStatus of [false, true]) {
        const result = await service.listRepositoryBranches(nested, { includeRepositoryStatus });
        expect(result.headBranch).toBe(detached ? undefined : "selected-work");
        expect(result.branches).toContainEqual({ name: "main", kind: "local" });
        expect(result.branches).toContainEqual({ name: "selected-work", kind: "local" });
      }
    },
  );

  it("reuses unchanged branch inventories and observes loose, packed, tag, and HEAD changes", async () => {
    const linked = path.join(root, "linked");
    await git(repo, "worktree", "add", "-b", "tasks/selected", linked, "HEAD");
    const run = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");
    const first = await service.listRepositoryBranches(linked);
    expect(first.headBranch).toBe("tasks/selected");
    run.mockClear();
    expect(await service.listRepositoryBranches(linked)).toEqual(first);
    expect(run).toHaveBeenCalledTimes(0);

    await git(repo, "branch", "tasks/added");
    expect((await service.listRepositoryBranches(linked)).branches).toContainEqual({
      name: "tasks/added",
      kind: "local",
    });
    await git(repo, "pack-refs", "--all", "--prune");
    await git(repo, "branch", "-d", "tasks/added");
    expect((await service.listRepositoryBranches(linked)).branches).not.toContainEqual({
      name: "tasks/added",
      kind: "local",
    });
    await git(repo, "tag", "tasks/selected");
    expect((await service.listRepositoryBranches(linked)).headBranch).toBe("heads/tasks/selected");
    await git(linked, "switch", "--detach");
    expect((await service.listRepositoryBranches(linked)).headBranch).toBeUndefined();
    expect((await service.listRepositoryBranches(repo)).headBranch).toBe("main");

    const commit = await git(repo, "rev-parse", "HEAD");
    const refs = path.join(repo, ".git", "refs", "heads", "fleet");
    await fs.mkdir(refs);
    await Promise.all(
      Array.from({ length: 810 }, (_, index) =>
        fs.writeFile(path.join(refs, String(index).padStart(4, "0")), `${commit}\n`),
      ),
    );
    const fleet = await service.listRepositoryBranches(repo);
    run.mockClear();
    expect(await service.listRepositoryBranches(repo)).toEqual(fleet);
    expect(run).toHaveBeenCalledTimes(0);
    await fs.unlink(path.join(refs, "0000"));
    expect((await service.listRepositoryBranches(repo)).branches).not.toContainEqual({
      name: "fleet/0000",
      kind: "local",
    });
  });

  it.each(["missing loose", "corrupt loose", "missing pack", "missing index", "corrupt pack"])(
    "rejects a %s HEAD object after a branch-list cache hit",
    async (damage) => {
      const head = await git(repo, "rev-parse", "HEAD");
      let object = path.join(repo, ".git", "objects", head.slice(0, 2), head.slice(2));
      if (!damage.endsWith("loose")) {
        await git(repo, "gc", "--prune=now");
        const packs = path.join(repo, ".git", "objects", "pack");
        const suffix = damage === "missing index" ? ".idx" : ".pack";
        object = path.join(
          packs,
          (await fs.readdir(packs)).find((name) => name.endsWith(suffix))!,
        );
      }
      if (damage.startsWith("corrupt")) {
        await fs.chmod(object, 0o600);
      }
      const run = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");
      const first = await service.listRepositoryBranches(repo, { includeRepositoryStatus: true });
      expect(first.repositoryStatus).toBe("git");
      run.mockClear();
      expect(await service.listRepositoryBranches(repo, { includeRepositoryStatus: true })).toEqual(
        first,
      );
      expect(run).toHaveBeenCalledTimes(0);
      if (damage.startsWith("missing")) {
        await fs.unlink(object);
      } else {
        await fs.writeFile(object, Buffer.alloc((await fs.stat(object)).size));
      }

      await expect(
        service.listRepositoryBranches(repo, { includeRepositoryStatus: true }),
      ).resolves.toEqual({
        branches: [],
        repositoryStatus: "unavailable",
      });
      await expect(service.listRepositoryBranches(repo)).rejects.toThrow(
        "Git metadata is unavailable",
      );
    },
  );

  it.each(["global", "worktree", "included", "environment", "relative", "parameters"])(
    "observes changed %s config after warming checkout admission",
    async (source) => {
      let config = path.join(root, "global.gitconfig");
      if (source === "worktree") {
        await git(repo, "config", "extensions.worktreeConfig", "true");
        config = path.join(repo, ".git", "config.worktree");
      } else if (source === "included") {
        config = path.join(root, "included.gitconfig");
        await git(repo, "config", "include.path", config);
      } else if (source === "relative") {
        config = path.join(repo, "global.gitconfig");
        vi.stubEnv("GIT_CONFIG_GLOBAL", "global.gitconfig");
      } else if (source === "parameters") {
        config = path.join(root, "included.gitconfig");
        vi.stubEnv("GIT_CONFIG_PARAMETERS", `'include.path=${config}'`);
      }
      const first = await service.listRepositoryBranches(repo, { includeRepositoryStatus: true });
      expect(first.repositoryStatus).toBe("git");
      expect(await service.listRepositoryBranches(repo, { includeRepositoryStatus: true })).toEqual(
        first,
      );
      if (source === "environment") {
        config = path.join(root, "redirected.gitconfig");
        vi.stubEnv("GIT_CONFIG_GLOBAL", config);
      }
      await fs.writeFile(config, "[malformed\n");
      expect(await service.listRepositoryBranches(repo, { includeRepositoryStatus: true })).toEqual(
        {
          branches: [],
          repositoryStatus: "unavailable",
        },
      );
    },
  );

  it("keeps tag peeling and alternate object storage under native Git admission", async () => {
    const head = await git(repo, "rev-parse", "HEAD");
    await git(repo, "tag", "-a", "tag-head", "-m", "tagged commit");
    const tag = await git(repo, "rev-parse", "tag-head");
    const alternate = path.join(root, "alternate");
    await git(root, "clone", "--shared", "--no-checkout", repo, alternate);
    await fs.writeFile(path.join(repo, ".git", "HEAD"), `${tag}\n`);
    for (const checkout of [repo, alternate]) {
      const first = await service.listRepositoryBranches(checkout, {
        includeRepositoryStatus: true,
      });
      expect(first.repositoryStatus).toBe("git");
      expect(
        await service.listRepositoryBranches(checkout, { includeRepositoryStatus: true }),
      ).toEqual(first);
    }
    await fs.unlink(path.join(repo, ".git", "objects", head.slice(0, 2), head.slice(2)));
    for (const checkout of [repo, alternate]) {
      expect(
        await service.listRepositoryBranches(checkout, { includeRepositoryStatus: true }),
      ).toEqual({
        branches: [],
        repositoryStatus: "unavailable",
      });
    }
  });

  it("keeps large repositories usable with bounded suggestions and an explicit unlisted base", async () => {
    const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
    const commit = stdout.trim();
    const refs = [
      ...["refs/heads", "refs/remotes/origin"].flatMap((prefix) =>
        Array.from(
          { length: 3_000 },
          (_, index) => `${prefix}/overflow-${String(index).padStart(80, "0")}`,
        ),
      ),
      "refs/remotes/origin/z-default",
    ].toSorted();
    await fs.writeFile(
      path.join(repo, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n" +
        refs.map((ref) => `${commit} ${ref}`).join("\n") +
        "\n",
    );

    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/z-default");
    await git(repo, "switch", "-c", "z-current");
    const inventory = await execFileAsync("git", [
      "-C",
      repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes",
    ]);
    expect(Buffer.byteLength(inventory.stdout)).toBeGreaterThan(256 * 1024);

    const result = await service.listRepositoryBranches(repo, { includeRepositoryStatus: true });
    expect(result.repositoryStatus).toBe("git");
    expect(result.branches.length).toBeLessThanOrEqual(202);
    expect(result.defaultBranch).toBe("origin/z-default");
    expect(result.headBranch).toBe("z-current");
    expect(result.branches).toEqual([
      { name: "origin/z-default", kind: "remote" },
      { name: "z-current", kind: "local" },
      { name: "main", kind: "local" },
      ...Array.from({ length: 99 }, (_, index) => ({
        name: `overflow-${String(index).padStart(80, "0")}`,
        kind: "local",
      })),
    ]);
    const run = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");
    expect(await service.listRepositoryBranches(repo, { includeRepositoryStatus: true })).toEqual(
      result,
    );
    expect(run).toHaveBeenCalledTimes(0);
    run.mockRestore();

    const baseRef = `origin/overflow-${String(2_999).padStart(80, "0")}`;
    expect(result.branches.some((branch) => branch.name === baseRef)).toBe(false);
    const worktree = await service.create({ repoRoot: repo, name: "unlisted-base", baseRef });
    const createdHead = await execFileAsync("git", ["-C", worktree.path, "rev-parse", "HEAD"]);
    expect(createdHead.stdout.trim()).toBe(commit);
    await expect(
      service.create({ repoRoot: repo, name: "invalid-base", baseRef: "missing-branch" }),
    ).rejects.toThrow(/base ref|resolve|revision/i);
  });

  it.each([
    { label: "fits the original byte guard", segments: 161, width: 8, available: true },
    { label: "exceeds the original byte guard", segments: 400, width: 3, available: false },
  ])(
    "retains Git availability when the bounded inventory $label",
    async ({ segments, width, available }) => {
      const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
      const prefix = "segment/".repeat(segments);
      const names = Array.from(
        { length: 100 },
        (_, index) => `${prefix}${String(index).padStart(width, "0")}`,
      );
      const refs = names.map((name) => `${stdout.trim()} refs/remotes/origin/${name}`);
      await fs.writeFile(path.join(repo, ".git", "packed-refs"), `${refs.join("\n")}\n`);
      if (available) {
        // Combined-probe metadata must not shrink the original fallback's byte budget.
        const legacy = await execFileAsync("git", [
          "-C",
          repo,
          "for-each-ref",
          "--format=%(refname)%00%(refname:short)",
          "refs/remotes/",
        ]);
        const expanded = await execFileAsync("git", [
          "-C",
          repo,
          "for-each-ref",
          "--format=%(refname)%00%(refname:short)%00%(symref)%00%(HEAD)",
          "refs/remotes/",
        ]);
        expect(Buffer.byteLength(legacy.stdout)).toBe(262_100);
        expect(Buffer.byteLength(expanded.stdout)).toBe(262_400);
      }
      await expect(
        service.listRepositoryBranches(repo, { includeRepositoryStatus: true }),
      ).resolves.toEqual({
        repositoryStatus: "git",
        ...(available ? {} : { branchesUnavailable: true }),
        branches: [
          { name: "main", kind: "local" },
          ...(available ? names.map((name) => ({ name: `origin/${name}`, kind: "remote" })) : []),
        ],
        headBranch: "main",
      });
    },
  );

  it.each(["local", "current", "default", "remote"] as const)(
    "keeps ambiguous %s branch suggestions usable even when Git warnings are disabled",
    async (selection) => {
      const initial = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
      const branchCommit = await execFileAsync("git", [
        "-C",
        repo,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        initial.stdout.trim(),
        "-m",
        "branch target",
      ]);
      const commit = branchCommit.stdout.trim();
      const remote = selection === "remote";
      const ref = remote ? "refs/remotes/origin/z-selected" : "refs/heads/z-selected";
      await git(repo, "config", "core.warnAmbiguousRefs", "false");
      await git(repo, "tag", remote ? "origin/z-selected" : "z-selected");
      await git(repo, "update-ref", ref, commit);
      if (selection !== "local") {
        const fillers = ["refs/heads", "refs/remotes/origin"].flatMap((prefix) =>
          Array.from(
            { length: 150 },
            (_, index) =>
              `${initial.stdout.trim()} ${prefix}/filler-${String(index).padStart(3, "0")}`,
          ),
        );
        await fs.writeFile(path.join(repo, ".git", "packed-refs"), `${fillers.join("\n")}\n`);
      }
      if (selection === "current") {
        await git(repo, "symbolic-ref", "HEAD", ref);
      }
      if (selection === "default" || remote) {
        await git(repo, "update-ref", "refs/remotes/origin/z-selected", commit);
        await git(
          repo,
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/z-selected",
        );
      }

      const result = await service.listRepositoryBranches(repo, { includeRepositoryStatus: true });
      const expected = remote ? "remotes/origin/z-selected" : "heads/z-selected";
      expect(result.branches).toContainEqual({ name: expected, kind: remote ? "remote" : "local" });
      expect(result.branches.length).toBeLessThanOrEqual(202);
      if (selection === "current") {
        expect(result.headBranch).toBe(expected);
      }
      if (selection === "default" || remote) {
        expect(result.defaultBranch).toBe(expected);
      }
      const created = await service.create({
        repoRoot: repo,
        name: "disambiguated",
        baseRef: expected,
      });
      const head = await execFileAsync("git", ["-C", created.path, "rev-parse", "HEAD"]);
      expect(head.stdout.trim()).toBe(commit);
    },
  );
});
