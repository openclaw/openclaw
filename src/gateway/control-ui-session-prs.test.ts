import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  requestUrl,
  routedFetch,
  testGitContext as context,
} from "./control-ui-session-prs.test-support.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

const { load: loadControlUiSessionPullRequests } = createSessionPullRequestsFixture();

vi.mock("../infra/git-worker.js", () => ({ runGitWorkerOperation: vi.fn() }));

const resolveGitContext = async () => context;
let cacheEpochMs = Date.now();

function localGitReads() {
  return vi
    .mocked(runGitWorkerOperation)
    .mock.calls.filter(([operation]) => operation.type !== "checkout.revision");
}

function paginatedChecksFetch(checkRuns: Record<string, unknown>[], laterStatus?: number) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(requestUrl(input));
    if (url.pathname.endsWith("/pulls")) {
      return githubJson([pullListItem()]);
    }
    if (url.pathname.endsWith("/pulls/103469")) {
      return githubJson({ additions: 4, deletions: 3 });
    }
    if (!url.pathname.endsWith("/check-runs")) {
      throw new Error(`unexpected GitHub request: ${url.href}`);
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("per_page") ?? 30);
    if (page > 1 && laterStatus) {
      return githubJson({ message: "Later page unavailable" }, laterStatus);
    }
    const response = githubJson({
      total_count: checkRuns.length,
      check_runs: checkRuns.slice((page - 1) * pageSize, page * pageSize),
    });
    if (page * pageSize < checkRuns.length) {
      url.searchParams.set("page", String(page + 1));
      response.headers.set("Link", `<${url.href}>; rel="next"`);
    }
    return response;
  });
}

describe("parseGitHubRemoteUrl", () => {
  it("parses the configured GitHub Enterprise host without admitting another host", () => {
    const expected = { owner: "acme", repo: "private-repo" };
    expect(
      parseGitHubRemoteUrl("https://ghe.example.test/acme/private-repo.git", "ghe.example.test"),
    ).toEqual(expected);
    expect(
      parseGitHubRemoteUrl("git@ghe.example.test:acme/private-repo.git", "ghe.example.test"),
    ).toEqual(expected);
    expect(
      parseGitHubRemoteUrl("https://github.com/acme/private-repo.git", "ghe.example.test"),
    ).toBeNull();
  });

  it("rejects non-GitHub and malformed remotes", () => {
    expect(parseGitHubRemoteUrl("https://gitlab.com/openclaw/openclaw.git")).toBeNull();
    expect(parseGitHubRemoteUrl("git@github.com:openclaw")).toBeNull();
    expect(parseGitHubRemoteUrl("https://github.com/openclaw/openclaw/extra")).toBeNull();
    expect(parseGitHubRemoteUrl("/local/path/repo.git")).toBeNull();
  });
});

describe("loadControlUiSessionPullRequests", () => {
  beforeEach(() => {
    vi.mocked(runGitWorkerOperation).mockReset();
    vi.useFakeTimers();
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    cacheEpochMs += 10 * 60_000;
    vi.setSystemTime(cacheEpochMs);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("returns chips with diff counts and check rollup for open PRs", async () => {
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([pullListItem()]) },
      {
        match: "/pulls/103469",
        response: () => githubJson({ additions: 4, deletions: 3, changed_files: 2 }),
      },
      {
        match: "/check-runs",
        response: () =>
          githubJson({
            total_count: 2,
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "skipped" },
            ],
          }),
      },
    ]);

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );

    expect(result).toEqual({
      repository: { owner: "openclaw", repo: "openclaw" },
      pullRequests: [
        {
          number: 103469,
          owner: "openclaw",
          repo: "openclaw",
          branch: context.branch,
          headSha: "a".repeat(40),
          title: "fix(macos): tighten the link-browser tab header",
          url: "https://github.com/openclaw/openclaw/pull/103469",
          state: "open",
          additions: 4,
          deletions: 3,
          changedFiles: 2,
          checks: { state: "passing", passed: 1, failed: 0, skipped: 1, running: 0 },
          checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
        },
      ],
      rateLimited: false,
    });
  });

  it("does not reuse cached private PRs after the GitHub token is removed", async () => {
    const cacheLifetime = new AbortController();
    vi.stubEnv("GH_TOKEN", "github-token-a");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      return authorization === "Bearer github-token-a"
        ? githubJson([
            pullListItem({
              title: "private PR from token A",
              merged_at: "2026-08-12T00:00:00Z",
            }),
          ])
        : githubJson({ message: "Not Found" }, 404);
    });

    try {
      const first = await loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:main" },
        { fetchImpl, resolveGitContext, cacheSignal: cacheLifetime.signal },
      );

      vi.stubEnv("GH_TOKEN", "");
      await expect(
        loadControlUiSessionPullRequests(
          { sessionKey: "agent:main:main" },
          { fetchImpl, resolveGitContext, cacheSignal: cacheLifetime.signal },
        ),
      ).resolves.toEqual({
        pullRequests: [],
        repository: { owner: "openclaw", repo: "openclaw" },
        rateLimited: false,
        status: "unavailable",
      });

      expect(first.pullRequests[0]?.title).toBe("private PR from token A");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[1]?.headers).toHaveProperty(
        "Authorization",
        "Bearer github-token-a",
      );
      expect(fetchImpl.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
      // The current credential's PR cache is the only retained lookup here.
      expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(1);
    } finally {
      cacheLifetime.abort();
    }
    expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(0);
  });

  it("marks in-flight checks pending and failed conclusions failing", async () => {
    const checkRuns = [
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "success" },
    ];
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([pullListItem()]) },
      { match: "/pulls/103469", response: () => githubJson({ additions: 1, deletions: 1 }) },
      {
        match: "/check-runs",
        response: () => githubJson({ total_count: checkRuns.length, check_runs: checkRuns }),
      },
    ]);

    const pending = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(pending.pullRequests[0]?.checks).toEqual({
      state: "pending",
      passed: 1,
      failed: 0,
      skipped: 0,
      running: 1,
    });

    vi.advanceTimersByTime(10 * 60_000);
    checkRuns[0] = { status: "completed", conclusion: "timed_out" };
    const failing = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(failing.pullRequests[0]?.checks).toEqual({
      state: "failing",
      passed: 1,
      failed: 1,
      skipped: 0,
      running: 0,
    });

    // A stale conclusion means GitHub invalidated the run; it must not be
    // rolled up as green.
    vi.advanceTimersByTime(10 * 60_000);
    checkRuns[0] = { status: "completed", conclusion: "stale" };
    const stale = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(stale.pullRequests[0]?.checks).toEqual({
      state: "pending",
      passed: 1,
      failed: 0,
      skipped: 0,
      running: 1,
    });
  });

  it("returns the complete rollup for verbose check output", async () => {
    const count = 100;
    const fetchImpl = paginatedChecksFetch(
      Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        status: "completed",
        conclusion: index === count - 1 ? "failure" : "success",
        output: { title: "Synthetic check", summary: "x".repeat(3_000) },
      })),
    );

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );

    expect(result.pullRequests[0]?.checks).toEqual({
      state: "failing",
      passed: count - 1,
      failed: 1,
      skipped: 0,
      running: 0,
    });
  });

  it("discards an incomplete rollup when a later page returns 403", async () => {
    const fetchImpl = paginatedChecksFetch(
      Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        status: "completed",
        conclusion: "success",
      })),
      403,
    );

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );

    expect(result.pullRequests[0]?.number).toBe(103469);
    expect(result.pullRequests[0]?.checks).toBeUndefined();
    expect(result.rateLimited).toBe(false);
  });

  it.each([
    { count: 0, summaryBytes: 0, passed: undefined },
    { count: 1_000, summaryBytes: 0, passed: 1_000 },
    { count: 1_001, summaryBytes: 0, passed: undefined },
  ])(
    "bounds check collection for $count runs with $summaryBytes output bytes",
    async ({ count, summaryBytes, passed }) => {
      const fetchImpl = paginatedChecksFetch(
        Array.from({ length: count }, (_, index) => ({
          id: index + 1,
          status: "completed",
          conclusion: "success",
          output: { summary: "x".repeat(summaryBytes) },
        })),
      );

      const result = await loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:main" },
        { fetchImpl, resolveGitContext },
      );

      expect(result.pullRequests[0]?.checks?.passed).toBe(passed);
      expect(
        fetchImpl.mock.calls.filter(([url]) => requestUrl(url).includes("/check-runs")).length,
      ).toBeLessThanOrEqual(10);
    },
  );

  it("falls back to the fork parent repo when the origin repo has no PRs", async () => {
    const fetchImpl = routedFetch([
      {
        match: "/repos/fork-owner/openclaw/pulls?head=",
        response: () => githubJson([]),
      },
      {
        match: "/repos/fork-owner/openclaw",
        response: () =>
          githubJson({
            fork: true,
            parent: { name: "openclaw", owner: { login: "openclaw" } },
          }),
      },
      {
        match: "/repos/openclaw/openclaw/pulls?head=",
        response: () => githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({ ...context, owner: "fork-owner" }),
      },
    );

    expect(result.pullRequests[0]?.number).toBe(103469);
    expect(
      fetchImpl.mock.calls.some((call) =>
        requestUrl(call[0] as RequestInfo | URL).includes(
          "head=fork-owner%3Aclaude%2Fbrowser-tabs-tighter-header",
        ),
      ),
    ).toBe(true);
  });

  it("serves stale chips flagged rateLimited when GitHub quota runs out", async () => {
    let limited = false;
    const rateLimitedResponse = () =>
      new Response(JSON.stringify({ message: "rate limited" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "0" },
      });
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          limited
            ? rateLimitedResponse()
            : githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);

    const fresh = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(fresh.rateLimited).toBe(false);
    expect(fresh.repository).toEqual({ owner: "openclaw", repo: "openclaw" });

    limited = true;
    vi.advanceTimersByTime(91_000);
    const stale = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(stale.rateLimited).toBe(true);
    expect(stale.pullRequests).toEqual(fresh.pullRequests);
    expect(stale.repository).toEqual(fresh.repository);

    const callsDuringBackoff = fetchImpl.mock.calls.length;
    const explicitRefresh = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );
    expect(explicitRefresh).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsDuringBackoff);

    vi.advanceTimersByTime(61_000);
    const stillBackedOff = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(stillBackedOff).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsDuringBackoff);
  });

  it("returns no chips without a git context and spends no quota", async () => {
    const fetchImpl = routedFetch([]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext: async () => null },
    );
    expect(result).toEqual({ pullRequests: [], rateLimited: false });
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it("revalidates local facts on refresh and observes changed merged heads or the slow fallback", async () => {
    let pulls: Record<string, unknown>[] = [];
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson(pulls) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    let additions = 1;
    vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) => {
      if (operation.type === "checkout.revision") {
        return "unchanged";
      }
      if (operation.type !== "pull-request.branch-facts") {
        throw new Error("Unexpected local Git operation");
      }
      return {
        creatable: true,
        stats: {
          additions: operation.input.root === "/repo/b" ? 3 : additions,
          deletions: 0,
          changedFiles: 1,
        },
      };
    });
    const load = (sessionKey: string, refresh = false) =>
      loadControlUiSessionPullRequests(
        { sessionKey, ...(refresh ? { refresh: true } : {}) },
        {
          fetchImpl,
          resolveGitContext: async () => ({
            ...context,
            branch: "cache/test",
            root: sessionKey.endsWith(":b") ? "/repo/b" : "/repo/a",
            defaultBranch: "main",
          }),
        },
      );

    expect((await load("agent:main:a")).branch?.additions).toBe(1);
    additions = 2;
    expect((await load("agent:main:a")).branch?.additions).toBe(1);
    expect(localGitReads()).toHaveLength(1);
    expect((await load("agent:main:a", true)).branch?.additions).toBe(1);
    expect(localGitReads()).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        requestUrl(call[0] as RequestInfo | URL).includes("/pulls?head="),
      ),
    ).toHaveLength(2);

    pulls = [pullListItem({ merged_at: "2026-07-09T10:00:00Z" })];
    additions = 4;
    expect((await load("agent:main:a", true)).branch?.additions).toBe(4);
    expect(localGitReads()).toHaveLength(2);

    const githubRequests = fetchImpl.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    additions = 5;
    expect((await load("agent:main:a")).branch?.additions).toBe(4);
    expect(localGitReads()).toHaveLength(2);
    expect(fetchImpl.mock.calls).toHaveLength(githubRequests);

    vi.advanceTimersByTime(240_001);
    additions = 5;
    expect((await load("agent:main:a")).branch?.additions).toBe(5);
    expect(localGitReads()).toHaveLength(3);

    expect((await load("agent:main:b")).branch?.additions).toBe(3);
    expect(localGitReads()).toHaveLength(4);
  });

  it("refreshes branch context on metadata changes without repeating it for working-tree activity", async () => {
    let branch = "feature-a";
    let revision: string | null = "initial";
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) => {
      if (operation.type === "checkout.revision") {
        return revision;
      }
      if (operation.type === "checkout.context") {
        return { ...context, branch, root: operation.input.root, defaultBranch: "main" };
      }
      if (operation.type === "pull-request.branch-facts") {
        return { creatable: true, stats: null };
      }
      throw new Error("Unexpected local Git operation");
    });
    const load = (refresh = false) =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:context-refresh", ...(refresh ? { refresh: true } : {}) },
        {
          fetchImpl,
          resolveGitRoot: async () => "/repo/forced-context",
        },
      );

    expect((await load()).branch?.branch).toBe("feature-a");
    branch = "feature-b";
    expect((await load()).branch?.branch).toBe("feature-a");
    expect((await load(true)).branch?.branch).toBe("feature-a");
    revision = "changed-head";
    expect((await load()).branch?.branch).toBe("feature-b");
    expect(
      localGitReads().filter(([operation]) => operation.type === "checkout.context"),
    ).toHaveLength(2);
    // Unsupported layouts retain immediate explicit branch discovery.
    revision = null;
    expect((await load()).branch?.branch).toBe("feature-b");
    branch = "feature-c";
    expect((await load(true)).branch?.branch).toBe("feature-c");
  });

  it("queues one forced refresh behind an ordinary in-flight lookup", async () => {
    let resolveInitialPulls!: (response: Response) => void;
    let signalInitialPullStarted!: () => void;
    const initialPulls = new Promise<Response>((resolve) => {
      resolveInitialPulls = resolve;
    });
    const initialPullStarted = new Promise<void>((resolve) => {
      signalInitialPullStarted = resolve;
    });
    let pullListCalls = 0;
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () => {
          pullListCalls += 1;
          if (pullListCalls === 1) {
            signalInitialPullStarted();
            return initialPulls;
          }
          return githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]);
        },
      },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);

    const initial = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    await initialPullStarted;
    const forcedRefresh = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );
    await Promise.resolve();
    const ordinaryFollower = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    const duplicateForcedRefresh = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );

    resolveInitialPulls(githubJson([]));
    expect((await initial).pullRequests).toEqual([]);
    expect(
      (await Promise.all([forcedRefresh, ordinaryFollower, duplicateForcedRefresh])).map((result) =>
        result.pullRequests.map((item) => item.number),
      ),
    ).toEqual([[103469], [103469], [103469]]);
    expect(pullListCalls).toBe(2);
  });

  it("keeps the proven PR list as state-only chips when detail fetches are rate limited", async () => {
    // A cached empty branch discovers a new PR before quota dies on detail fetches.
    const rateLimitedResponse = () =>
      new Response(JSON.stringify({ message: "rate limited" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "0" },
      });
    let hasPull = false;
    const routes = [
      {
        match: "/pulls?head=",
        response: () => githubJson(hasPull ? [pullListItem({ user: { login: "octocat" } })] : []),
      },
      { match: "/pulls/103469", response: rateLimitedResponse },
      { match: "/check-runs", response: rateLimitedResponse },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ];
    const fetchImpl = routedFetch(routes);

    const beforePublication = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(beforePublication.pullRequests).toEqual([]);
    expect(beforePublication.branch).toBeDefined();
    hasPull = true;

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );

    expect(result.rateLimited).toBe(true);
    expect(result.branch).toBeUndefined();
    expect(result.pullRequests).toEqual([
      {
        number: 103469,
        owner: "openclaw",
        repo: "openclaw",
        branch: context.branch,
        headSha: "a".repeat(40),
        title: "fix(macos): tighten the link-browser tab header",
        url: "https://github.com/openclaw/openclaw/pull/103469",
        state: "open",
        // The list fetch succeeded, so its author survives the degraded chip.
        author: { login: "octocat" },
      },
    ]);

    // Outage outlives the rate-limit cache window and now even the list
    // fetch 429s: the proven chips must survive as the last-known fallback.
    routes.length = 0;
    routes.push({ match: "/pulls?head=", response: rateLimitedResponse });
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    const stillLimited = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(stillLimited.rateLimited).toBe(true);
    expect(stillLimited.pullRequests.map((item) => item.number)).toEqual([103469]);
  });
});
import { getEventListeners } from "node:events";
