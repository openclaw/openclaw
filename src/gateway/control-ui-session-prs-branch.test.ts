import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as worktreeGit from "../agents/worktrees/git.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import * as gitWorker from "../infra/git-worker.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createTestControlUiSessionPrSubscriptions,
  createTestSessionPrReadSource,
  prepareTestSessionPrRead,
} from "./control-ui-session-pr-subscriptions.test-support.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  localPrGitReads as localGitReads,
  mockPrCheckout,
  requestUrl,
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
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("discovers GitHub identity locally and skips network for default, non-GitHub, and detached checkouts", async () => {
    await initializeRepo();
    await trackRemote("main");
    await connectGithub();
    vi.stubGlobal("fetch", routedFetch([]));
    const load = () => loadCheckout("discovery", true);
    const initial = {
      status: "ready",
      pullRequests: [],
      rateLimited: false,
      repository: { owner: "openclaw", repo: "openclaw" },
    };
    expect(await load()).toEqual(initial);
    const reads = vi.spyOn(worktreeGit, "runGitBytes");
    await writeCommit("a.txt", "next commit\n", "advance main", true);
    await trackRemote("main");
    expect(await load()).toEqual(initial);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    await git("remote", "set-url", "origin", "https://gitlab.com/openclaw/openclaw.git");
    await expect(load()).resolves.toEqual({
      pullRequests: [],
      rateLimited: false,
      status: "ready",
    });
    await git("remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
    await git("checkout", "--detach");
    await expect(load()).resolves.toEqual(initial);
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(0);
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
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
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
    vi.advanceTimersByTime(5 * 60_000 + 1);
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

  describe("fork head discovery", () => {
    const forkOwner = "PratikRai0101";
    const forkContext = () => runGitReadOperation({ type: "checkout.context", input: { root } });

    it("derives bounded candidates from tracking refs and invalidates a renamed remote", async () => {
      await initializeFeatureWork();
      await connectGithub();
      await git("remote", "add", "fork", `https://github.com/${forkOwner}/openclaw.git`);
      vi.stubGlobal(
        "fetch",
        routedFetch([
          {
            match: `/pulls?head=${forkOwner}%3A`,
            response: () =>
              githubJson([
                pullListItem({
                  head: {
                    sha: "a".repeat(40),
                    ref: "feature",
                    repo: { full_name: `${forkOwner}/openclaw` },
                  },
                }),
              ]),
          },
          { match: "/pulls?head=", response: () => githubJson([]) },
          { match: "/pulls/103469", response: () => githubJson({ additions: 1, deletions: 0 }) },
          { match: "/commits/", response: () => githubJson({ total_count: 0, check_runs: [] }) },
          { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
        ]),
      );
      const load = () => loadCheckout("fork-discovery");
      // Prove ref-only invalidation before other remotes also change Git config.
      expect((await load()).pullRequests).toEqual([]);
      await git("update-ref", "refs/remotes/fork/feature", "HEAD");
      await git("pack-refs", "--all", "--prune");
      const discovered = await load();
      expect(discovered.repository).toEqual({ owner: "openclaw", repo: "openclaw" });
      expect(discovered.pullRequests.map((pull) => pull.number)).toEqual([103469]);
      for (const name of ["zz-a", "zz-b", "zz-c"]) {
        await git("remote", "add", name, `https://github.com/${name}/openclaw.git`);
        await git("update-ref", `refs/remotes/${name}/feature`, "HEAD");
      }
      await git("remote", "add", "not-github", "https://gitlab.com/someone/openclaw.git");
      await git("update-ref", "refs/remotes/not-github/feature", "HEAD");
      await git("remote", "add", "same-owner", "https://github.com/openclaw/openclaw.git");
      await git("update-ref", "refs/remotes/same-owner/feature", "HEAD");
      await git("remote", "add", "untracked", "https://github.com/untracked/openclaw.git");
      // No push or tracking configuration names the fork.
      const keys = ["branch.feature.pushRemote", "remote.pushDefault", "branch.feature.remote"];
      for (const key of keys) {
        await expect(git("config", "--get", key)).rejects.toThrow();
      }

      await git("tag", "feature");
      await git("tag", "origin/main");
      expect(await forkContext()).toMatchObject({
        originUrl: "https://github.com/openclaw/openclaw.git",
        branch: "feature",
        defaultBranch: "main",
        forkHeadCandidates: [
          { owner: forkOwner, repo: "openclaw" },
          { owner: "zz-a", repo: "openclaw" },
          { owner: "zz-b", repo: "openclaw" },
        ],
      });

      await git("tag", "-d", "feature", "origin/main");
      await git("remote", "set-url", "fork", "https://github.com/lonexreb/paloa-claw.git");
      expect((await forkContext())?.forkHeadCandidates?.[0]).toEqual({
        owner: "lonexreb",
        repo: "paloa-claw",
      });
      expect((await load()).pullRequests).toEqual([]);
    });
  });
});

// Revision-aware Git caches belong to the native source, behind the plugin read contract.
describe("native checkout observations behind the session PR SDK", () => {
  let elapsedMs = 0;
  const running = new Set<Awaited<ReturnType<typeof createTestControlUiSessionPrSubscriptions>>>();
  beforeEach(() => {
    vi.spyOn(gitWorker, "runGitWorkerOperation");
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });
  afterEach(async () => {
    for (const service of running) {
      await service.stop();
    }
    running.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const load = (
    params: Partial<Parameters<typeof loadControlUiSessionPullRequests>[0]> = {},
    deps: Parameters<typeof loadControlUiSessionPullRequests>[1] = {},
  ) =>
    loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", ...params },
      { resolveGitContext: async () => context, ...deps },
    );
  const pullsRoute = (response: () => Response | Promise<Response>) => ({
    match: "/pulls?head=",
    response,
  });
  const repoRoute = () => ({
    match: "/repos/openclaw/openclaw",
    response: () => githubJson({ fork: false }),
  });
  it("revalidates local facts on refresh and observes changed merged heads or the slow fallback", async () => {
    let pulls: Record<string, unknown>[] = [];
    const fetchImpl = routedFetch([pullsRoute(() => githubJson(pulls)), repoRoute()]);
    vi.stubGlobal("fetch", fetchImpl);
    let additions = 1;
    mockPrCheckout({
      revision: () => "unchanged",
      additions: (root) => (root === "/repo/b" ? 3 : additions),
    });
    const loadSession = (sessionKey: string, refresh = false) =>
      load(
        { sessionKey, ...(refresh ? { refresh: true } : {}) },
        {
          resolveGitContext: async () => ({
            ...context,
            branch: "cache/test",
            root: sessionKey.endsWith(":b") ? "/repo/b" : "/repo/a",
            defaultBranch: "main",
          }),
        },
      );

    expect((await loadSession("agent:main:a")).branch?.additions).toBe(1);
    additions = 2;
    expect((await loadSession("agent:main:a")).branch?.additions).toBe(1);
    expect(localGitReads()).toHaveLength(1);
    expect((await loadSession("agent:main:a", true)).branch?.additions).toBe(1);
    expect(localGitReads()).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        requestUrl(call[0] as RequestInfo | URL).includes("/pulls?head="),
      ),
    ).toHaveLength(2);

    pulls = [pullListItem({ merged_at: "2026-07-09T10:00:00Z" })];
    additions = 4;
    expect((await loadSession("agent:main:a", true)).branch?.additions).toBe(4);
    expect(localGitReads()).toHaveLength(2);

    const githubRequests = fetchImpl.mock.calls.length;
    elapsedMs += 60_000;
    vi.advanceTimersByTime(60_000);
    additions = 5;
    expect((await loadSession("agent:main:a")).branch?.additions).toBe(4);
    expect(localGitReads()).toHaveLength(2);
    expect(fetchImpl.mock.calls).toHaveLength(githubRequests);

    elapsedMs += 240_001;
    vi.advanceTimersByTime(240_001);
    expect((await loadSession("agent:main:a")).branch?.additions).toBe(5);
    expect(localGitReads()).toHaveLength(3);

    expect((await loadSession("agent:main:b")).branch?.additions).toBe(3);
    expect(localGitReads()).toHaveLength(4);
  });

  it("refreshes branch context on metadata changes without repeating it for working-tree activity", async () => {
    let branch = "feature-a";
    let revision: string | null = "initial";
    vi.stubGlobal("fetch", routedFetch([pullsRoute(() => githubJson([])), repoRoute()]));
    mockPrCheckout({
      revision: () => revision,
      resolve: (root) => ({
        originUrl: `https://github.com/${context.owner}/${context.repo}`,
        branch,
        root,
        defaultBranch: "main",
      }),
    });
    const loadContext = (refresh = false) =>
      load(
        { sessionKey: "agent:main:context-refresh", ...(refresh ? { refresh: true } : {}) },
        { resolveGitRoot: async () => "/repo/forced-context", resolveGitContext: undefined },
      );

    expect((await loadContext()).branch?.branch).toBe("feature-a");
    branch = "feature-b";
    expect((await loadContext()).branch?.branch).toBe("feature-a");
    expect((await loadContext(true)).branch?.branch).toBe("feature-a");
    revision = "changed-head";
    expect((await loadContext()).branch?.branch).toBe("feature-b");
    expect(
      localGitReads().filter(([operation]) => operation.type === "checkout.context"),
    ).toHaveLength(2);
    // Unsupported layouts retain immediate explicit branch discovery.
    revision = null;
    expect((await loadContext()).branch?.branch).toBe("feature-b");
    branch = "feature-c";
    expect((await loadContext(true)).branch?.branch).toBe("feature-c");
  });

  const stubPulls = (response: () => Response, includeRepository = false) => {
    const fetchImpl = routedFetch([
      pullsRoute(response),
      ...(includeRepository ? [repoRoute()] : []),
    ]);
    vi.stubGlobal("fetch", fetchImpl);
    return fetchImpl;
  };
  const watchedKeys = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => `watched-${index + offset}`);
  const mockCheckout = (
    revision: () => string | null,
    branch: (root: string) => string | null,
    additions?: () => number,
  ) =>
    mockPrCheckout({
      revision,
      additions,
      emptyFacts: true,
      resolve: (root) => ({
        originUrl: "https://github.com/openclaw/openclaw",
        root,
        branch: branch(root),
        defaultBranch: "main",
      }),
    });
  const subscribe = async (
    root: string | ((key: string) => string),
    broadcastToConnIds: Parameters<
      typeof createTestControlUiSessionPrSubscriptions
    >[0]["broadcastToConnIds"] = vi.fn(),
  ) => {
    const readSource = createTestSessionPrReadSource();
    const clock = createGatewaySchedulerClock(Date.now());
    const service = await createTestControlUiSessionPrSubscriptions({
      scheduler: createTestGatewayScheduler(clock.clock),
      broadcastToConnIds,
      prepareRead: async (_connId, session) => async () =>
        prepareTestSessionPrRead({
          session: {
            ...session,
            agentId: session.agentId ?? "main",
            sessionId: session.sessionKey,
          },
          identity: session.sessionKey,
          readSource,
          source: {
            kind: "checkout",
            root: typeof root === "string" ? root : root(session.sessionKey),
          },
        }),
    });
    running.add(service);
    return service;
  };
  const pollAfter = async (service: Awaited<ReturnType<typeof subscribe>>, elapsed: number) => {
    elapsedMs += elapsed;
    vi.setSystemTime(Date.now() + elapsed);
    await service.pollNow();
  };

  it("shares checkout facts across subscribers and refreshes both only when refs change", async () => {
    let revision = "first-head";
    let additions = 1;
    stubPulls(() => githubJson([]), true);
    mockCheckout(
      () => revision,
      () => "shared-feature",
      () => additions,
    );
    const broadcastToConnIds = vi.fn();
    const subscriptions = await subscribe("/watched/shared-checkout", broadcastToConnIds);
    const expectReads = (count: number) => {
      for (const type of ["checkout.context", "pull-request.branch-facts"]) {
        expect(localGitReads().filter(([operation]) => operation.type === type)).toHaveLength(
          count,
        );
      }
    };
    const expectDelivered = (connId: string, sessionKey: string, expectedAdditions: number) => {
      const snapshot = expect.objectContaining({
        status: "ready",
        branch: expect.objectContaining({ additions: expectedAdditions }),
      });
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "controlUi.sessionPullRequests.changed",
        { sessions: { [sessionKey]: snapshot } },
        new Set([connId]),
        expect.anything(),
      );
    };
    await Promise.all([
      subscriptions.replace("first", ["shared-first"]),
      subscriptions.replace("second", ["shared-second"]),
    ]);
    expectReads(1);
    expectDelivered("first", "shared-first", 1);
    expectDelivered("second", "shared-second", 1);

    broadcastToConnIds.mockClear();
    await subscriptions.replace("first", ["shared-first"], new Set(["shared-first"]));
    await subscriptions.pollNow();
    expectReads(1);
    expectDelivered("first", "shared-first", 1);

    revision = "second-head";
    additions = 2;
    broadcastToConnIds.mockClear();
    await subscriptions.pollNow();
    expectReads(2);
    expectDelivered("first", "shared-first", 2);
    expectDelivered("second", "shared-second", 2);

    subscriptions.unsubscribe("first");
    broadcastToConnIds.mockClear();
    await subscriptions.replace("second", ["shared-second"], new Set(["shared-second"]));
    expectReads(2);
    expectDelivered("second", "shared-second", 2);
  });

  it("retains GitHub snapshots for the watched union across a poll", async () => {
    const fetchImpl = stubPulls(() =>
      githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
    );
    mockCheckout(
      () => "unchanged",
      (root) => root.slice("/watched/".length),
    );
    const subscriptions = await subscribe((key) => `/watched/${key}`);
    await subscriptions.replace("first", watchedKeys(200));
    await subscriptions.replace("second", watchedKeys(100, 200));
    expect(fetchImpl.mock.calls).toHaveLength(300);
    expect(localGitReads()).toHaveLength(600);

    for (const elapsed of [60_000, 15_001]) {
      await pollAfter(subscriptions, elapsed);
      expect(fetchImpl.mock.calls).toHaveLength(300);
      expect(localGitReads()).toHaveLength(600);
    }
    await pollAfter(subscriptions, 225_000);
    expect(localGitReads()).toHaveLength(900);
    await subscriptions.stop();
    running.delete(subscriptions);
  });
});
