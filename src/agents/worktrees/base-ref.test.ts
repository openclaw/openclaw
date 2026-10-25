import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as gitExec from "../../infra/git-exec.js";
import { git, gitIdentity } from "./git-fixture.test-support.js";
import * as preparation from "./service-preparation.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

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

  it.each(["branch", "detached"])(
    "creates from local HEAD without origin on a %s checkout",
    async (checkout) => {
      await git(repo, "remote", "remove", "origin");
      await git(repo, "switch", "-c", "local-work");
      await fs.writeFile(path.join(repo, "README.md"), "local commit\n");
      await git(repo, "add", "README.md");
      await git(repo, ...gitIdentity, "commit", "-m", "local work");
      const expectedHead = await head(repo);
      if (checkout === "detached") {
        await git(repo, "checkout", "--detach", expectedHead);
      }
      joinAllocations(2);
      const execute = gitExec.executeGitCommand;
      const remoteCommands: string[] = [];
      vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
        if (["remote", "ls-remote", "fetch", "merge"].includes(args[0]!)) {
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
      expect(remoteCommands).toEqual(["remote"]);
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
