import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as worktreeGit from "../agents/worktrees/git.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext as context,
} from "./control-ui-session-prs.test-support.js";

const { load: loadControlUiSessionPullRequests } = createSessionPullRequestsFixture();
const branchIdentity = { ...context, branch: "feature" };

describe("session branch diff stats", () => {
  const execFileAsync = promisify(execFile);
  const templateDirs = useAutoCleanupTempDirTracker(afterAll);
  let templateRepo: string;
  let root: string;

  const gitIn = (cwd: string, ...args: string[]) =>
    execFileAsync("git", ["-c", "user.email=test@openclaw.ai", "-c", "user.name=Test", ...args], {
      cwd,
    });
  const git = (...args: string[]) => gitIn(root, ...args);

  const writeFile = (file: string, contents: string | Uint8Array, append = false) =>
    (append ? fs.appendFile : fs.writeFile)(path.join(root, file), contents);
  const commit = async (message: string, ...files: string[]) => {
    await git("add", ...files);
    await git("commit", "-m", message);
  };

  const writeCommit = async (file: string, contents: string, message: string, append = false) => {
    await writeFile(file, contents, append);
    await commit(message, file);
  };

  const trackRemote = (branch: string, revision = "HEAD") =>
    git("update-ref", `refs/remotes/origin/${branch}`, revision);
  const resolveRevision = async (revision: string) =>
    (await git("rev-parse", revision)).stdout.trim();

  const initializeRepo = async (initialContents = "one\n", repo = root) => {
    if (repo === root && initialContents === "one\n") {
      return fs.cp(templateRepo, root, { recursive: true });
    }
    await gitIn(repo, "init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(repo, "a.txt"), initialContents);
    await gitIn(repo, "add", "a.txt");
    await gitIn(repo, "commit", "-m", "base");
  };

  const initializeFeatureWork = async ({
    trackMain = true,
    trackFeature = false,
    contents = "one\n",
    committed = true,
  } = {}) => {
    await initializeRepo(contents);
    if (trackMain) {
      await trackRemote("main");
    }
    await git("checkout", "-b", "feature");
    if (committed) {
      await writeCommit("a.txt", "two\n", "feature work", true);
    }
    if (trackFeature) {
      await trackRemote("feature");
    }
  };

  const mergedPull = (headSha: string, overrides: Record<string, unknown> = {}) =>
    pullListItem({
      state: "closed",
      merged_at: "2026-07-01T00:00:00Z",
      head: { sha: headSha },
      ...overrides,
    });

  const stubGithub = (pullRequests?: Array<Record<string, unknown>>) => {
    const routes = [{ match: "/pulls?head=", response: () => githubJson(pullRequests ?? []) }];
    if (pullRequests === undefined) {
      routes.push({
        match: "/repos/openclaw/openclaw",
        response: () => githubJson({ fork: false }),
      });
    }
    vi.stubGlobal("fetch", routedFetch(routes));
  };
  const loadBranchState = (pullRequests?: Array<Record<string, unknown>>) => {
    stubGithub(pullRequests);
    return loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        resolveGitContext: async () => ({ ...branchIdentity, root, defaultBranch: "main" }),
      },
    );
  };

  const loadMergedBranchState = (headSha: string, overrides: Record<string, unknown> = {}) =>
    loadBranchState([mergedPull(headSha, overrides)]);
  const loadCheckout = (sessionKey: string, refresh = false) =>
    loadControlUiSessionPullRequests(
      { sessionKey: `agent:main:${sessionKey}`, refresh },
      { resolveGitRoot: async () => root },
    );
  const connectGithub = async () => {
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  };
  const expectedBranch = (additions: number, deletions: number, changedFiles: number) => ({
    ...branchIdentity,
    additions,
    deletions,
    changedFiles,
    createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
  });

  beforeAll(async () => {
    templateRepo = templateDirs.make("openclaw-session-prs-template-");
    await initializeRepo("one\n", templateRepo);
  });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-prs-")));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("discovers GitHub identity locally and skips network for default, non-GitHub, and detached checkouts", async () => {
    await initializeRepo();
    await trackRemote("main");
    await connectGithub();
    const fetchImpl = routedFetch([]);
    vi.stubGlobal("fetch", fetchImpl);
    const load = () => loadCheckout("discovery", true);
    const expected = {
      pullRequests: [],
      rateLimited: false,
      repository: { owner: "openclaw", repo: "openclaw" },
    };
    await expect(load()).resolves.toEqual(expected);
    const reads = vi.spyOn(worktreeGit, "runGitBytes");
    const initial = await load();
    reads.mockClear();
    await writeCommit("a.txt", "next commit\n", "advance main", true);
    await trackRemote("main");
    expect(await load()).toEqual(initial);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    await git("remote", "set-url", "origin", "https://gitlab.com/openclaw/openclaw.git");
    await expect(load()).resolves.toEqual({ pullRequests: [], rateLimited: false });
    await git("remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
    await git("checkout", "--detach");
    await expect(load()).resolves.toEqual(expected);
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it("counts committed and uncommitted changes vs the origin default merge base", async () => {
    await initializeFeatureWork({ contents: "one\ntwo\n", committed: false });
    await writeFile("a.txt", "one\nthree\n");
    await writeFile("b.txt", "committed\n");
    await commit("feature work", "a.txt", "b.txt");
    await trackRemote("feature");
    await writeFile("b.txt", "pending\n", true);
    await writeFile("c.txt", "brand new\n");

    const result = await loadBranchState();
    expect(result.branch).toEqual(expectedBranch(4, 1, 3));
  });

  it("counts bounded regular untracked text without trimming names, including hardlinks", async () => {
    await initializeFeatureWork({ trackFeature: true });
    await writeFile(" text.txt", "alpha\nbeta\n");
    await writeFile("blob.bin", Buffer.from([0x50, 0x00, 0x4b, 0x03]));
    await writeFile("empty.txt", "");
    await writeFile("oversized.txt", "not counted\n");
    await fs.truncate(path.join(root, "oversized.txt"), 512 * 1024 + 1);
    await fs.link(path.join(root, " text.txt"), path.join(root, "hardlink.txt"));
    if (process.platform !== "win32") {
      // A named pipe must not block the stats path until the git timeout.
      await execFileAsync("mkfifo", [path.join(root, "pipe")]);
      await fs.symlink(" text.txt", path.join(root, "symlink.txt"));
    }

    const result = await loadBranchState();
    // One committed line and two two-line regular files; hardlinks are allowed for counts.
    expect(result.branch).toMatchObject({ additions: 5, deletions: 0 });
  });

  it("keeps PR facts when unrelated snapshot refs change or refs are packed", async () => {
    await initializeFeatureWork({ trackFeature: true });
    await connectGithub();
    stubGithub();
    const load = () => loadCheckout("snapshot-refs");
    const initial = await load();
    expect(initial.branch).toMatchObject({ additions: 1, changedFiles: 1 });
    const reads = vi.spyOn(worktreeGit, "runGitBytes");
    await git("update-ref", "refs/openclaw/snapshots/unrelated", "HEAD");
    expect(await load()).toEqual(initial);
    expect(reads.mock.calls.length).toBe(0);
    await git("pack-refs", "--all", "--prune");
    expect(await load()).toEqual(initial);
    expect(reads.mock.calls.length).toBe(0);

    // File-only edits still refresh statistics, without repeating unchanged ancestry.
    await writeFile("a.txt", "three\n", true);
    await writeFile("new.txt", "new\n");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
    const [first, concurrent] = await Promise.all([load(), load()]);
    expect(first).toEqual(concurrent);
    expect(first.branch).toMatchObject({ additions: 3, changedFiles: 2 });
    expect(reads.mock.calls.filter(([, args]) => args[0] === "merge-base")).toHaveLength(0);
    expect(reads.mock.calls.filter(([, args]) => args.includes("--shortstat"))).toHaveLength(1);

    reads.mockClear();
    await trackRemote("feature", "refs/remotes/origin/main");
    const changed = await load();
    expect(changed.branch).toMatchObject({ additions: 3, changedFiles: 2 });
    expect(changed.branch?.createUrl).toBeUndefined();
    expect(reads.mock.calls.some(([, args]) => args[0] === "merge-base")).toBe(true);
  });

  it("does not refresh stat-dirty binary files in an unowned checkout", async () => {
    await initializeFeatureWork({ committed: false });
    await writeFile("image.bin", Buffer.from([0, 1, 2, 3]));
    await commit("binary fixture", "image.bin");
    await trackRemote("main");
    await trackRemote("feature");
    const indexPath = path.join(root, ".git", "index");
    const originalIndex = await fs.readFile(indexPath);
    await fs.utimes(path.join(root, "image.bin"), new Date(0), new Date(0));
    await runGitReadOperation({
      type: "pull-request.branch-facts",
      input: {
        root,
        branch: "feature",
        defaultBranch: "main",
        mergedHeads: [],
        refreshIndex: false,
      },
    });
    expect(await fs.readFile(indexPath)).toEqual(originalIndex);
  });

  it("stops dependent comparisons after the second ancestry probe times out", async () => {
    await initializeFeatureWork({ trackFeature: true });
    const run = worktreeGit.runGitBytes;
    let ancestryCalls = 0;
    vi.spyOn(worktreeGit, "runGitBytes").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "merge-base" && ++ancestryCalls >= 2) {
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
      return run(cwd, args, options);
    });
    const result = await loadMergedBranchState("1".repeat(40));
    expect(result.branch).toEqual(branchIdentity);
    expect(ancestryCalls).toBe(2);
  });

  it("reads missing historical PR heads without transport on older Git", async () => {
    await initializeFeatureWork({ trackFeature: true });
    await git("config", "extensions.partialClone", "origin");
    await git("config", "remote.origin.promisor", "true");
    await git("config", "remote.origin.url", path.join(root, "unavailable-remote"));
    const tracePath = path.join(root, ".git", "trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", tracePath);
    const run = worktreeGit.runGitBytes;
    vi.spyOn(worktreeGit, "runGitBytes").mockImplementation((cwd, args, options) =>
      run(cwd, args, {
        ...options,
        // Older Git ignores this variable; the transport policy must still hold.
        env: { ...options?.env, GIT_NO_LAZY_FETCH: undefined },
      }),
    );
    const result = await loadMergedBranchState("1".repeat(40));
    expect(result.branch).toMatchObject({ additions: 1, changedFiles: 1 });
    const childStarts = (await fs.readFile(tracePath, "utf8"))
      .split("\n")
      .filter((line) => line.includes('"event":"child_start"'));
    expect(childStarts.join("\n")).not.toContain('"child_class":"transport/');
  });

  it("suppresses the Create PR row when the merged PR falls outside the display cap", async () => {
    await initializeFeatureWork({ trackFeature: true });
    const mergedHead = await resolveRevision("HEAD");
    const result = await loadBranchState([
      ...[5, 4, 3].map((number) => pullListItem({ number, state: "closed" })),
      mergedPull(mergedHead),
    ]);
    expect(result.branch).toBeUndefined();
  });

  it("restores Create PR for a branch rebased past the landing with new work", async () => {
    await initializeFeatureWork({ trackMain: false });
    const mergedHead = await resolveRevision("HEAD");
    // Reuse the branch after squash-landing it: reset to main, add work, and force-push.
    await git("checkout", "main");
    await writeCommit("a.txt", "two\n", "squash land", true);
    const mergeCommit = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");
    await git("reset", "--hard", "refs/remotes/origin/main");
    await writeCommit("b.txt", "second round\n", "second PR work");
    await trackRemote("feature");

    const result = await loadMergedBranchState(mergedHead, { merge_commit_sha: mergeCommit });
    // A merge base containing the landing proves this new commit is a second PR.
    expect(result.branch).toEqual(expectedBranch(1, 0, 1));
  });
});
