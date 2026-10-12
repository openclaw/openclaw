import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as preparation from "./service-preparation.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("managed worktree creation groups", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worktree-creation-group-");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "global.gitconfig"));
    repo = await initializeRepository(root);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  it("shares one dirty local-default decision across a burst of twenty creates", async () => {
    const localHead = await git(repo, "rev-parse", "HEAD");
    const remote = path.join(root, "remote.git");
    const remoteHead = await git(
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
      "remote update",
    );
    await git(remote, "update-ref", "refs/heads/main", remoteHead);
    await fs.writeFile(path.join(repo, "README.md"), "local work\n");
    const allocate = preparation.createWithWorktreeAllocation;
    const joined = createDeferred();
    let callers = 0;
    vi.spyOn(preparation, "createWithWorktreeAllocation").mockImplementation(async (...args) => {
      if (++callers === 20) {
        joined.resolve();
      }
      await joined.promise;
      return await allocate(...args);
    });
    const execute = gitExec.executeGitCommand;
    let fetches = 0;
    let statusReads = 0;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "fetch") {
        fetches++;
      }
      if (args[0] === "status") {
        statusReads++;
      }
      return await execute(cwd, args, options);
    });
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
      Array.from({ length: 20 }, (_, index) =>
        service.create({ repoRoot: repo, name: `burst-${index}` }),
      ),
    );

    expect(records).toHaveLength(20);
    expect(new Set(records.map((record) => record.baseRef))).toEqual(new Set(["origin/main"]));
    expect(await git(repo, "rev-parse", "HEAD")).toBe(localHead);
    expect(await git(repo, "rev-parse", "origin/main")).toBe(remoteHead);
    expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe("local work\n");
    expect(failures).toEqual([]);
    expect(fetches).toBe(1);
    expect(statusReads).toBe(1);
  });

  it("shares a prepared default with creators queued past its fetch settlement", async ({
    signal,
  }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
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
      const late = await service.create({ repoRoot: repo, name: "cohort-late" });
      expect(await git(late.path, "rev-parse", "HEAD")).toBe(head);
      expect(fetches).toBe(1);
      // An overlapping creation must not extend the freshness window indefinitely.
      clock.mockReturnValue(now + 30_000);
      await service.create({ repoRoot: repo, name: "cohort-expired" });
      expect(fetches).toBe(2);
      releaseSecond.resolve();
      const createdSecond = await withinTest(second, signal);
      expect(fetches).toBe(2);
      expect(await git(createdFirst.path, "rev-parse", "HEAD")).toBe(head);
      expect(await git(createdSecond.path, "rev-parse", "HEAD")).toBe(head);
      expect(
        await git(createdSecond.path, "rev-parse", "--symbolic-full-name", "@{upstream}"),
      ).toBe("refs/remotes/origin/main");
      const repeated = await service.create({ repoRoot: repo, name: "cohort-second" });
      expect(repeated.id).toBe(createdSecond.id);
      expect(fetches).toBe(2);
      await service.create({ repoRoot: repo, name: "cohort-fresh" });
      expect(fetches).toBe(2);
    } finally {
      secondAdmitted.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("reuses a recent default, then refreshes after its freshness window", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const original = await service.create({ repoRoot: repo, name: "original" });
    const oldHead = await git(original.path, "rev-parse", "HEAD");
    const remote = path.join(root, "remote.git");
    const newHead = await git(
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
      "remote update",
    );
    await git(remote, "update-ref", "refs/heads/main", newHead);

    clock.mockReturnValue(now + 29_000);
    const recent = await service.create({ repoRoot: repo, name: "recent" });
    expect(await git(recent.path, "rev-parse", "HEAD")).toBe(oldHead);

    clock.mockReturnValue(now + 30_000);
    const refreshed = await service.create({ repoRoot: repo, name: "refreshed" });
    expect(await git(refreshed.path, "rev-parse", "HEAD")).toBe(newHead);
  });
});
