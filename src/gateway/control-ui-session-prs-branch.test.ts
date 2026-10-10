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

  const writeFile = (file: string, contents: string | Uint8Array) =>
    fs.writeFile(path.join(root, file), contents);
  const appendFile = (file: string, contents: string) =>
    fs.appendFile(path.join(root, file), contents);

  const commit = async (message: string, ...files: string[]) => {
    await git("add", ...files);
    await git("commit", "-m", message);
  };

  const writeCommit = async (file: string, contents: string, message: string) => {
    await writeFile(file, contents);
    await commit(message, file);
  };

  const appendCommit = async (file: string, contents: string, message: string) => {
    await appendFile(file, contents);
    await commit(message, file);
  };

  const trackRemote = (branch: string, revision = "HEAD") =>
    git("update-ref", `refs/remotes/origin/${branch}`, revision);
  const resolveRevision = async (revision: string) =>
    (await git("rev-parse", revision)).stdout.trim();

  const initializeRepoAt = async (repo: string, initialContents = "one\n") => {
    await gitIn(repo, "init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(repo, "a.txt"), initialContents);
    await gitIn(repo, "add", "a.txt");
    await gitIn(repo, "commit", "-m", "base");
  };

  const initializeRepo = async (initialContents = "one\n") => {
    if (initialContents !== "one\n") {
      await initializeRepoAt(root, initialContents);
      return;
    }
    // Each case owns its .git directory; only the unchanged base history is copied.
    await fs.cp(templateRepo, root, { recursive: true });
  };

  const initializeFeatureBranch = async (initialContents = "one\n") => {
    await initializeRepo(initialContents);
    await trackRemote("main");
    await git("checkout", "-b", "feature");
  };

  type FeatureWorkOptions = {
    message?: string;
    trackFeature?: boolean;
    trackMain?: boolean;
  };

  const initializeFeatureWork = async ({
    message = "feature work",
    trackMain = true,
    trackFeature = false,
  }: FeatureWorkOptions = {}) => {
    await initializeRepo();
    if (trackMain) {
      await trackRemote("main");
    }
    await git("checkout", "-b", "feature");
    await appendCommit("a.txt", "two\n", message);
    if (trackFeature) {
      await trackRemote("feature");
    }
  };

  const initializeFeatureHead = async (options: FeatureWorkOptions = {}) => {
    await initializeFeatureWork(options);
    return resolveRevision(options.trackFeature ? "refs/remotes/origin/feature" : "HEAD");
  };

  const mergedPull = (headSha: string, overrides: Record<string, unknown> = {}) =>
    pullListItem({
      state: "closed",
      merged_at: "2026-07-01T00:00:00Z",
      head: { sha: headSha },
      ...overrides,
    });

  const loadBranchState = async ({
    pullRequests,
    defaultBranch = "main",
  }: {
    pullRequests?: Array<Record<string, unknown>>;
    defaultBranch?: string | null;
  } = {}) => {
    const routes = [{ match: "/pulls?head=", response: () => githubJson(pullRequests ?? []) }];
    if (pullRequests === undefined) {
      routes.push({
        match: "/repos/openclaw/openclaw",
        response: () => githubJson({ fork: false }),
      });
    }
    return loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl: routedFetch(routes),
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          ...(defaultBranch === null ? {} : { defaultBranch }),
        }),
      },
    );
  };

  const loadMergedBranchState = (headSha: string, overrides: Record<string, unknown> = {}) =>
    loadBranchState({ pullRequests: [mergedPull(headSha, overrides)] });

  beforeAll(async () => {
    templateRepo = templateDirs.make("openclaw-session-prs-template-");
    await initializeRepoAt(templateRepo);
  });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-prs-")));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("discovers GitHub identity locally and skips network for default, non-GitHub, and detached checkouts", async () => {
    await initializeRepo();
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await trackRemote("main");
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const fetchImpl = routedFetch([]);
    const load = () =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:discovery", refresh: true },
        { fetchImpl, resolveGitRoot: async () => root },
      );
    await expect(load()).resolves.toEqual({
      pullRequests: [],
      rateLimited: false,
      repository: { owner: "openclaw", repo: "openclaw" },
    });
    await git("remote", "set-url", "origin", "https://gitlab.com/openclaw/openclaw.git");
    await expect(load()).resolves.toEqual({ pullRequests: [], rateLimited: false });
    await git("remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
    await git("checkout", "--detach");
    await expect(load()).resolves.toEqual({
      pullRequests: [],
      rateLimited: false,
      repository: { owner: "openclaw", repo: "openclaw" },
    });
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it("counts committed and uncommitted changes vs the origin default merge base", async () => {
    await initializeFeatureBranch("one\ntwo\n");
    // Stand in for the remote default branch without a real remote.
    await writeFile("a.txt", "one\nthree\n");
    await writeFile("b.txt", "committed\n");
    await commit("feature work", "a.txt", "b.txt");
    await trackRemote("feature");
    // Uncommitted work counts too: the row sizes the PR the push would open.
    await appendFile("b.txt", "pending\n");
    // Untracked files count toward additions as well.
    await writeFile("c.txt", "brand new\n");

    const result = await loadBranchState();
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 4,
      deletions: 1,
      changedFiles: 3,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    });
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
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const load = () =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:snapshot-refs" },
        { fetchImpl, resolveGitRoot: async () => root },
      );
    const initial = await load();
    expect(initial.branch).toMatchObject({ additions: 1, changedFiles: 1 });
    const reads = vi.spyOn(worktreeGit, "runGitBytes");
    try {
      await git("update-ref", "refs/openclaw/snapshots/unrelated", "HEAD");
      expect(await load()).toEqual(initial);
      expect(reads.mock.calls.length).toBe(0);
      await git("pack-refs", "--all", "--prune");
      expect(await load()).toEqual(initial);
      expect(reads.mock.calls.length).toBe(0);
    } finally {
      reads.mockRestore();
    }
  });

  it("does not refresh stat-dirty binary files in an unowned checkout", async () => {
    await initializeFeatureBranch();
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

  it.each([2])("stops dependent comparisons after ancestry probe %s times out", async (probe) => {
    await initializeFeatureWork({ trackFeature: true });
    const run = worktreeGit.runGitBytes;
    let ancestryCalls = 0;
    const reads = vi
      .spyOn(worktreeGit, "runGitBytes")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "merge-base" && ++ancestryCalls >= probe) {
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
    try {
      const result = await loadMergedBranchState("1".repeat(40));
      expect(result.branch).toEqual({ owner: "openclaw", repo: "openclaw", branch: "feature" });
      expect(ancestryCalls).toBe(probe);
    } finally {
      reads.mockRestore();
    }
  });

  it("reads missing historical PR heads without transport on older Git", async () => {
    await initializeFeatureWork({ trackFeature: true });
    await git("config", "extensions.partialClone", "origin");
    await git("config", "remote.origin.promisor", "true");
    await git("config", "remote.origin.url", path.join(root, "unavailable-remote"));
    const tracePath = path.join(root, ".git", "trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", tracePath);
    const run = worktreeGit.runGitBytes;
    const reads = vi.spyOn(worktreeGit, "runGitBytes").mockImplementation((cwd, args, options) =>
      run(cwd, args, {
        ...options,
        // Older Git ignores this variable; the transport policy must still hold.
        env: { ...options?.env, GIT_NO_LAZY_FETCH: undefined },
      }),
    );
    try {
      const result = await loadMergedBranchState("1".repeat(40));
      expect(result.branch).toMatchObject({ additions: 1, changedFiles: 1 });
      const trace = await fs.readFile(tracePath, "utf8");
      expect(
        trace
          .split("\n")
          .filter(
            (line) =>
              line.includes('"event":"child_start"') && line.includes('"child_class":"transport/'),
          ),
      ).toEqual([]);
    } finally {
      reads.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("suppresses the Create PR row when the merged PR falls outside the display cap", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });
    const closedPull = (n: number) =>
      pullListItem({ number: n, title: `closed ${n}`, state: "closed" });

    const result = await loadBranchState({
      // GitHub sorts by updated desc: three fresher closed-unmerged PRs push
      // the merged PR past the MAX_PULL_REQUESTS display slice.
      pullRequests: [closedPull(5), closedPull(4), closedPull(3), mergedPull(mergedHead)],
    });
    // A merged head that is not displayed still proves the pushed tip landed.
    expect(result.branch).toBeUndefined();
  });

  it("restores Create PR for a branch rebased past the landing with new work", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false });
    // Reuse the branch after squash-landing it: reset to main, add work, and force-push.
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "squash land");
    const mergeCommit = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");
    await git("reset", "--hard", "refs/remotes/origin/main");
    await writeCommit("b.txt", "second round\n", "second PR work");
    await trackRemote("feature");

    const result = await loadMergedBranchState(mergedHead, { merge_commit_sha: mergeCommit });
    // A merge base containing the landing proves this new commit is a second PR.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    });
  });
});
