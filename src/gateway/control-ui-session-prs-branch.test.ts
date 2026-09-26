import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as worktreeGit from "../agents/worktrees/git.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import { loadSessionPullRequestReferences } from "./control-ui-session-pr-references.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext as context,
} from "./control-ui-session-prs.test-support.js";

const { load: loadControlUiSessionPullRequests } = createSessionPullRequestsFixture();

vi.mock("./control-ui-session-pr-references.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-session-pr-references.js")>()),
  loadSessionPullRequestReferences: vi.fn(async () => []),
}));

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
    vi.mocked(loadSessionPullRequestReferences).mockResolvedValue([]);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-prs-")));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["loose", "packed", "detached", "linked"])(
    "reads %s HEAD and remote refs without probes and preserves checkout context",
    async (layout) => {
      await initializeRepo();
      await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
      await trackRemote("main");
      await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      let cwd = root;
      if (layout === "linked") {
        cwd = path.join(root, "linked");
        await git("worktree", "add", "-b", "feature", cwd);
      } else if (layout === "detached") {
        await git("checkout", "--detach");
      } else {
        await git("checkout", "-b", "feature");
        if (layout === "packed") {
          await git("pack-refs", "--all", "--prune");
        }
      }
      const reads = vi.spyOn(worktreeGit, "runGitBytes");
      try {
        await expect(
          runGitReadOperation(
            { type: "checkout.context", input: { root: cwd } },
            { refresh: true },
          ),
        ).resolves.toEqual({
          owner: "openclaw",
          repo: "openclaw",
          root: cwd,
          branch: layout === "detached" ? null : "feature",
          defaultBranch: "main",
        });
        expect(reads.mock.calls).toHaveLength(1);
        expect(reads.mock.calls.filter(([, args]) => args[0] === "rev-parse")).toHaveLength(0);
        await runGitReadOperation(
          {
            type: "pull-request.branch-facts",
            input: { root: cwd, branch: "feature", defaultBranch: "main", mergedHeads: [] },
          },
          { refresh: true },
        );
        expect(reads.mock.calls.filter(([, args]) => args[0] === "rev-parse")).toHaveLength(0);
        expect(reads.mock.calls.filter(([, args]) => args[0] === "for-each-ref")).toHaveLength(0);
        await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
        reads.mockClear();
        expect(
          await runGitReadOperation(
            { type: "checkout.context", input: { root: cwd } },
            { refresh: true },
          ),
        ).toMatchObject({ defaultBranch: "release" });
        expect(reads.mock.calls).toHaveLength(1);
        await git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
        reads.mockClear();
        expect(
          await runGitReadOperation(
            { type: "checkout.context", input: { root: cwd } },
            { refresh: true },
          ),
        ).not.toHaveProperty("defaultBranch");
        expect(reads.mock.calls).toHaveLength(1);
      } finally {
        reads.mockRestore();
      }
    },
  );

  it.each([
    "symbolic chain",
    "ambiguous name",
    ...(process.platform === "win32" ? [] : ["symlink"]),
  ])("preserves Git's default branch discovery with a %s", async (layout) => {
    await initializeRepo();
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await trackRemote("main");
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    if (layout === "symbolic chain") {
      await git("symbolic-ref", "refs/remotes/origin/main", "refs/heads/main");
    } else if (layout === "ambiguous name") {
      await git("tag", "origin/main");
    } else {
      await git(
        "-c",
        "core.preferSymlinkRefs=true",
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );
    }
    const defaultRef = (
      await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    ).stdout.trim();
    expect(
      await runGitReadOperation({ type: "checkout.context", input: { root } }, { refresh: true }),
    ).toMatchObject({ defaultBranch: defaultRef.replace(/^origin\//, "") });
  });

  it.each(["loose", "packed", "symbolic", ...(process.platform === "win32" ? [] : ["symlink"])])(
    "refreshes branch stats after %s remote refs advance and disappear",
    async (layout) => {
      await initializeFeatureWork({ trackFeature: true });
      if (layout === "packed") {
        await git("pack-refs", "--all", "--prune");
      } else if (layout === "symbolic") {
        await git("symbolic-ref", "refs/remotes/origin/main", "refs/heads/main");
      } else if (layout === "symlink") {
        const ref = path.join(root, ".git", "refs", "remotes", "origin", "main");
        await fs.unlink(ref);
        await fs.symlink("../../heads/main", ref);
      }
      const read = () =>
        runGitReadOperation(
          {
            type: "pull-request.branch-facts",
            input: { root, branch: "feature", defaultBranch: "main", mergedHeads: [] },
          },
          { refresh: true },
        );
      await expect(read()).resolves.toEqual({
        creatable: true,
        stats: { additions: 1, deletions: 0, changedFiles: 1 },
      });
      await trackRemote("main");
      await expect(read()).resolves.toBeUndefined();
      await git("update-ref", "-d", "refs/remotes/origin/main");
      await expect(read()).resolves.toEqual({ creatable: true, stats: null });
    },
  );

  it.each([
    "HEAD tag",
    "detached HEAD tag",
    "worktree pseudoref",
    "packed exact name",
    "virtual worktree name",
  ])("preserves Git discovery with an ambiguous %s", async (collision) => {
    await initializeRepo();
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    let cwd = root;
    if (collision === "worktree pseudoref") {
      cwd = path.join(root, "linked");
      await git("worktree", "add", "-b", "ORIG_HEAD", cwd);
      await gitIn(cwd, "update-ref", "ORIG_HEAD", "HEAD");
    } else if (collision === "packed exact name") {
      await git("pack-refs", "--all", "--prune");
      await git("checkout", "-b", "refs/heads/main");
    } else if (collision === "virtual worktree name") {
      await git("checkout", "-b", "main-worktree/HEAD");
    } else {
      if (collision === "detached HEAD tag") {
        await git("checkout", "--detach");
      }
      await git("update-ref", "refs/tags/HEAD", "HEAD");
    }
    const expectedBranch = await gitIn(cwd, "rev-parse", "--abbrev-ref", "HEAD").then(
      (result) => result.stdout.trim(),
      () => null,
    );
    await expect(
      runGitReadOperation({ type: "checkout.context", input: { root: cwd } }, { refresh: true }),
    ).resolves.toEqual(
      expectedBranch
        ? {
            owner: "openclaw",
            repo: "openclaw",
            root: cwd,
            branch: expectedBranch === "HEAD" ? null : expectedBranch,
          }
        : null,
    );
  });

  it("keeps Git's ambiguous branch names and admission-time discovery overrides", async () => {
    await initializeRepo();
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await git("checkout", "-b", "feature");
    await git("tag", "feature");
    const read = () =>
      runGitReadOperation({ type: "checkout.context", input: { root } }, { refresh: true });
    const expected = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    expect((await read())?.branch).toBe(expected);
    if (process.platform !== "win32") {
      await git("config", "core.preferSymlinkRefs", "true");
      await git("symbolic-ref", "HEAD", "refs/heads/feature");
      expect((await read())?.branch).toBe(expected);
    }
    // Reuse the warm worker after its host environment changes.
    const redirected = path.join(root, "redirected");
    await fs.cp(templateRepo, redirected, { recursive: true });
    await gitIn(redirected, "remote", "add", "origin", "https://github.com/example/redirected.git");
    vi.stubEnv("GIT_DIR", path.join(redirected, ".git"));
    try {
      expect(await read()).toMatchObject({ owner: "example", repo: "redirected", branch: "main" });
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("discovers referenced PRs from other worktrees while detached and after returning to main", async () => {
    await initializeFeatureWork();
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await git("checkout", "--detach");
    vi.mocked(loadSessionPullRequestReferences).mockResolvedValue([42, 43]);
    let failureStatus: number | undefined;
    const fetchImpl = routedFetch([
      {
        match: "/pulls/42",
        response: () =>
          failureStatus
            ? githubJson({ message: "GitHub unavailable" }, failureStatus)
            : githubJson(
                pullListItem({
                  number: 42,
                  state: "closed",
                  merged_at: "2026-09-01T00:00:00Z",
                  html_url: "https://github.com/openclaw/openclaw/pull/42",
                  head: { ref: "feature/first", sha: "a".repeat(40) },
                }),
              ),
      },
      {
        match: "/pulls/43",
        response: () =>
          githubJson(
            pullListItem({
              number: 43,
              head: { ref: "feature/follow-up", sha: "b".repeat(40) },
              html_url: "https://github.com/openclaw/openclaw/pull/43",
              additions: 8,
              deletions: 2,
            }),
          ),
      },
      {
        match: "/check-runs",
        response: () =>
          githubJson({
            total_count: 1,
            check_runs: [{ status: "completed", conclusion: "success" }],
          }),
      },
    ]);
    const load = () =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:references", refresh: true },
        { fetchImpl, resolveGitRoot: async () => root },
      );
    const detached = await load();
    expect(detached.pullRequests).toMatchObject([
      {
        number: 43,
        branch: "feature/follow-up",
        state: "open",
        additions: 8,
        checks: { state: "passing" },
      },
      { number: 42, branch: "feature/first", state: "merged" },
    ]);
    expect(detached.branch).toBeUndefined();
    await git("checkout", "main");
    expect(await load()).toEqual(detached);
    expect(fetchImpl.mock.calls).toHaveLength(6);
    failureStatus = 503;
    expect(await load()).toEqual({ ...detached, status: "unavailable" });
    failureStatus = 429;
    expect(await load()).toEqual({ ...detached, rateLimited: true });
    const callsAtBackoff = fetchImpl.mock.calls.length;
    expect(await load()).toEqual({ ...detached, rateLimited: true });
    expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff);
  });

  it("does not treat a referenced PR's merge as landing the working branch", async () => {
    const head = await initializeFeatureHead({ trackFeature: true });
    vi.mocked(loadSessionPullRequestReferences).mockResolvedValue([42]);
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      {
        match: "/pulls/42",
        response: () =>
          githubJson(
            mergedPull(head, {
              number: 42,
              head: { sha: head, ref: "other-branch" },
            }),
          ),
      },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:other-branch", refresh: true },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );
    expect(result.pullRequests).toMatchObject([
      { number: 42, state: "merged", branch: "other-branch" },
    ]);
    expect(result.branch?.createUrl).toBe("https://github.com/openclaw/openclaw/pull/new/feature");
  });

  it("keeps publication available when a referenced fork PR has the same branch name", async () => {
    await initializeFeatureWork({ trackFeature: true });
    vi.mocked(loadSessionPullRequestReferences).mockResolvedValue([42]);
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      {
        match: "/pulls/42",
        response: () =>
          githubJson(
            pullListItem({
              number: 42,
              head: { ref: "feature", repo: { owner: { login: "contributor" }, name: "fork" } },
            }),
          ),
      },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const load = () =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:fork-reference", refresh: true },
        {
          fetchImpl,
          resolveGitContext: async () => ({
            ...context,
            branch: "feature",
            root,
            defaultBranch: "main",
          }),
        },
      );
    const result = await load();
    expect(result.pullRequests).toMatchObject([{ number: 42, state: "open", branch: "feature" }]);
    expect(result.branch?.createUrl).toBe("https://github.com/openclaw/openclaw/pull/new/feature");
    vi.mocked(loadSessionPullRequestReferences).mockRejectedValueOnce(new Error("indexing"));
    const indexing = await load();
    expect(indexing.branch).toEqual(result.branch);
    expect(indexing.pullRequests).toEqual(result.pullRequests);
    expect(indexing.status).toBeUndefined();
  });

  it("preserves proven branch PRs across unavailable references and new links during backoff", async () => {
    await initializeFeatureWork({ trackFeature: true });
    vi.mocked(loadSessionPullRequestReferences).mockResolvedValue([42]);
    let hasPull = false;
    let limited = false;
    let referenceStatus = 503;
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          limited
            ? githubJson({}, 429)
            : githubJson(hasPull ? [pullListItem({ head: { ref: "feature" } })] : []),
      },
      { match: "/pulls/103469", response: () => githubJson({ additions: 1, deletions: 0 }) },
      { match: "/pulls/42", response: () => githubJson({}, hasPull ? referenceStatus : 404) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const load = () =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:changing-references", refresh: true },
        {
          fetchImpl,
          resolveGitContext: async () => ({
            ...context,
            branch: "feature",
            root,
            defaultBranch: "main",
          }),
        },
      );
    expect((await load()).branch).toBeDefined();
    hasPull = true;
    const published = await load();
    expect(published.pullRequests).toMatchObject([{ number: 103469, state: "open" }]);
    expect(published.branch).toBeUndefined();
    expect(published.status).toBe("unavailable");
    expect(published.rateLimited).toBe(false);
    vi.mocked(loadSessionPullRequestReferences).mockRejectedValueOnce(new Error("indexing"));
    expect(await load()).toEqual(published);

    referenceStatus = 404;
    const recovered = await load();
    expect(recovered.pullRequests).toEqual(published.pullRequests);
    expect(recovered.branch).toBeUndefined();
    expect(recovered.status).toBeUndefined();

    limited = true;
    vi.mocked(loadSessionPullRequestReferences).mockResolvedValue([43]);
    const stale = await load();
    expect(stale.pullRequests).toEqual(published.pullRequests);
    expect(stale.rateLimited).toBe(true);
    expect(stale.branch).toBeUndefined();
    const callsAtBackoff = fetchImpl.mock.calls.length;
    vi.mocked(loadSessionPullRequestReferences).mockResolvedValue([44]);
    expect(await load()).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff);
  });

  it("reports unavailable reference discovery on default and detached checkouts", async () => {
    await initializeRepo();
    await git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await trackRemote("main");
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    vi.mocked(loadSessionPullRequestReferences).mockRejectedValue(new Error("indexing"));
    const fetchImpl = routedFetch([]);
    const load = () =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:no-reference-discovery", refresh: true },
        { fetchImpl, resolveGitRoot: async () => root },
      );
    const unavailable = {
      pullRequests: [],
      rateLimited: false,
      status: "unavailable",
      repository: { owner: "openclaw", repo: "openclaw" },
    };
    expect(await load()).toEqual(unavailable);
    await git("checkout", "--detach");
    expect(await load()).toEqual(unavailable);
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

  it("counts only bounded regular untracked text, including hardlinks", async () => {
    await initializeFeatureWork({ trackFeature: true });
    await writeFile("text.txt", "alpha\nbeta\n");
    await writeFile("blob.bin", Buffer.from([0x50, 0x00, 0x4b, 0x03]));
    await writeFile("empty.txt", "");
    await writeFile("oversized.txt", "not counted\n");
    await fs.truncate(path.join(root, "oversized.txt"), 512 * 1024 + 1);
    await fs.link(path.join(root, "text.txt"), path.join(root, "hardlink.txt"));
    if (process.platform !== "win32") {
      // A named pipe must not block the stats path until the git timeout.
      await execFileAsync("mkfifo", [path.join(root, "pipe")]);
      await fs.symlink("text.txt", path.join(root, "symlink.txt"));
    }

    const result = await loadBranchState();
    // One committed line and two two-line regular files; hardlinks are allowed for counts.
    expect(result.branch).toMatchObject({ additions: 5, deletions: 0 });
  });

  it.each(["none", "uncommitted", "unpushed"])(
    "preserves %s local work at equal remote tips without recounting commits",
    async (localWork) => {
      await initializeFeatureBranch();
      await trackRemote("feature");
      if (localWork === "uncommitted") {
        await appendFile("a.txt", "pending\n");
      } else if (localWork === "unpushed") {
        await appendCommit("a.txt", "pending\n", "local only");
      }
      const reads = vi.spyOn(worktreeGit, "runGitBytes");
      try {
        const result = await loadBranchState();
        expect(result.branch).toEqual(
          localWork === "none"
            ? undefined
            : {
                owner: "openclaw",
                repo: "openclaw",
                branch: "feature",
                additions: 1,
                deletions: 0,
                changedFiles: 1,
              },
        );
        expect(reads).toHaveBeenCalled();
        expect(reads.mock.calls.filter(([, args]) => args[0] === "rev-list")).toHaveLength(0);
      } finally {
        reads.mockRestore();
      }
    },
  );

  it("reports local changes without createUrl until the branch exists on origin", async () => {
    await initializeFeatureBranch();
    await appendCommit("a.txt", "two\n", "local only");

    const result = await loadBranchState();
    // Unpushed branches have no GitHub pull/new page, but changed files still get a row.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
  });

  it.each(["missing object", "malformed ref"])(
    "preserves unknown comparison behavior for equal remote tips with a %s",
    async (problem) => {
      await initializeFeatureBranch();
      await trackRemote("feature");
      const value = problem === "missing object" ? "1".repeat(40) : "not-an-object-id";
      for (const branch of ["main", "feature"]) {
        await fs.writeFile(
          path.join(root, ".git", "refs", "remotes", "origin", branch),
          `${value}\n`,
        );
      }
      const result = await loadBranchState();
      expect(result.branch?.createUrl).toBe(
        problem === "missing object"
          ? "https://github.com/openclaw/openclaw/pull/new/feature"
          : undefined,
      );
    },
  );

  it("drops the Create PR row once the pushed tip is a merged PR's head", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    expect(result.pullRequests[0]?.state).toBe("merged");
    // A squash-merged remote tip must not resurrect a duplicate Create PR invitation.
    expect(result.branch).toBeUndefined();
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

  it("sizes only post-merge work, without a create link, once the PR landed", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });
    await appendFile("a.txt", "follow-up\n");

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // Ignore the stale merged +1; only the uncommitted follow-up counts.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
  });

  it("keeps the Create PR row when the PR merged into a non-default base", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });

    const result = await loadMergedBranchState(mergedHead, {
      base: { ref: "release", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    });
    // A release-branch merge leaves the default-branch Create PR available.
    expect(result.branch?.createUrl).toBe("https://github.com/openclaw/openclaw/pull/new/feature");
  });

  it("suppresses the row via local HEAD when the merged remote ref was pruned", async () => {
    // Model a merge-deleted head branch after its remote-tracking ref was pruned.
    const mergedHead = await initializeFeatureHead();

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // Without this, the stale merge base replays the landed diff forever.
    expect(result.branch).toBeUndefined();
  });

  it.each(["lowercase", "uppercase"])(
    "suppresses the row when the local checkout trails the merged remote tip with %s ref text",
    async (refCase) => {
      const olderMergedHead = await initializeFeatureHead();
      await appendCommit("a.txt", "second PR\n", "second PR");
      const staleHead = await resolveRevision("HEAD");
      // Four commits: default -> older merge -> local HEAD -> newer merge.
      await appendCommit("a.txt", "review fix\n", "review fix");
      await trackRemote("feature");
      const mergedHead = await resolveRevision("HEAD");
      await git("reset", "--hard", staleHead);
      if (refCase === "uppercase") {
        await fs.writeFile(
          path.join(root, ".git", "refs", "heads", "feature"),
          `${staleHead.toUpperCase()}\n`,
        );
      }
      expect(await resolveRevision("HEAD")).toBe(staleHead);

      const result = await loadBranchState({
        pullRequests: [
          mergedPull(olderMergedHead, { number: 1 }),
          mergedPull(mergedHead, { number: 2 }),
        ],
      });
      // The clean, fully merged stale checkout must not replay a landed subset.
      expect(result.branch).toBeUndefined();
    },
  );

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

  it("counts a release-branch landing once its merge commit reaches main", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false, trackFeature: true });
    // The PR merged into a release branch whose squash later reached main.
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "release merge propagated");
    const mergeCommit = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");

    const result = await loadMergedBranchState(mergedHead, {
      merge_commit_sha: mergeCommit,
      base: { ref: "release", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    });
    // Once the release landing reaches main, its non-default base no longer matters.
    expect(result.branch).toBeUndefined();
  });

  it("restores Create PR atop a merge-commit landing without a rebase", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false });
    // A merge-commit landing keeps the head an ancestor of main.
    await git("checkout", "main");
    await git("merge", "--no-ff", "feature", "-m", "merge PR");
    const mergeCommit = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");
    await writeCommit("b.txt", "follow-up\n", "follow-up work");
    await trackRemote("feature");

    const result = await loadMergedBranchState(mergedHead, { merge_commit_sha: mergeCommit });
    // The merge base contains the merged head, leaving only the follow-up to compare.
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

  it("keeps Create PR off while a newer squash landing is unincorporated", async () => {
    // PR1: squash-land, then the branch rebases past it.
    const pr1Head = await initializeFeatureHead({ message: "pr1 work", trackMain: false });
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "squash pr1");
    const pr1Merge = await resolveRevision("HEAD");
    await git("checkout", "feature");
    await git("reset", "--hard", "main");
    // PR2 squash-lands, but the branch is not rebased again before its follow-up.
    await writeCommit("b.txt", "pr2\n", "pr2 work");
    const pr2Head = await resolveRevision("HEAD");
    await git("checkout", "main");
    await writeCommit("b.txt", "pr2\n", "squash pr2");
    const pr2Merge = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");
    await writeCommit("c.txt", "follow-up\n", "follow-up work");
    await trackRemote("feature");

    const result = await loadBranchState({
      pullRequests: [
        mergedPull(pr2Head, {
          number: 2,
          merged_at: "2026-07-02T00:00:00Z",
          merge_commit_sha: pr2Merge,
        }),
        mergedPull(pr1Head, { number: 1, merge_commit_sha: pr1Merge }),
      ],
    });
    // Only PR1 is in the merge base, so show the follow-up but keep Create PR off.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
  });

  it("offers no Create PR from a stale tracking ref behind the merged head", async () => {
    const staleSha = await initializeFeatureHead();
    await appendCommit("a.txt", "final fix\n", "final fix");
    const mergedHead = await resolveRevision("HEAD");
    // This checkout's tracking ref and HEAD predate a final commit merged elsewhere.
    await trackRemote("feature", staleSha);
    await git("reset", "--hard", staleSha);

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // A stale ref is not new work when the merged head already contains it.
    expect(result.branch).toBeUndefined();
  });

  it("prefers the newer merge base after the default branch was merged back in", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false, trackFeature: true });
    // Main advances after the squash landing, then is merged back into the feature.
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "squash land");
    await writeCommit("b.txt", "unrelated\n", "unrelated main work");
    await trackRemote("main");
    await git("checkout", "feature");
    await git("merge", "refs/remotes/origin/main", "-m", "merge main");

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // Main's merge-base tip carries the landing; the older head would replay its progress.
    expect(result.branch).toBeUndefined();
  });

  it("ignores the merged tip as a diff base when the branch was reset onto main", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false, trackFeature: true });
    // Squash-land the same content on main, then main moves on.
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "squash land");
    await writeCommit("b.txt", "unrelated\n", "unrelated main work");
    await trackRemote("main");
    // Reset the branch onto updated main while origin/feature stays on the merged head.
    await git("checkout", "feature");
    await git("reset", "--hard", "refs/remotes/origin/main");

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // The merge base excludes unrelated main progress that a stale-tip diff would replay.
    expect(result.branch).toBeUndefined();
  });

  it("keeps post-merge commits as a stats-only row until the branch rebases", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });
    await appendCommit("a.txt", "three\n", "post-merge work");
    await trackRemote("feature");

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // Count the post-merge commit, but hide Create PR until the branch incorporates the landing.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
  });

  it.each([null, "main"])(
    "handles a missing default tracking ref when the known default branch is %s",
    async (defaultBranch) => {
      await initializeRepo();
      await git("checkout", "-b", "feature");
      await trackRemote("feature");
      const result = await loadBranchState({ defaultBranch });
      if (defaultBranch) {
        // An unavailable local comparison must not hide a known pushed branch.
        expect(result.branch?.createUrl).toBe(
          "https://github.com/openclaw/openclaw/pull/new/feature",
        );
      } else {
        expect(result.branch).toBeUndefined();
      }
    },
  );
});
