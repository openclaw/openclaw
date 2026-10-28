import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  localPrGitReads as localGitReads,
  mockPrCheckout,
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

type LoadParams = Parameters<typeof loadControlUiSessionPullRequests>[0];
type LoadDeps = Parameters<typeof loadControlUiSessionPullRequests>[1];

const load = (params: Partial<LoadParams> = {}, deps: LoadDeps = {}) =>
  loadControlUiSessionPullRequests(
    { sessionKey: "agent:main:main", ...params },
    { resolveGitContext, ...deps },
  );

const rateLimitedResponse = () =>
  new Response(JSON.stringify({ message: "rate limited" }), {
    status: 403,
    headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "0" },
  });

const chip = (overrides: Record<string, unknown> = {}) => ({
  number: 103469,
  owner: "openclaw",
  repo: "openclaw",
  branch: context.branch,
  headSha: "a".repeat(40),
  title: "fix(macos): tighten the link-browser tab header",
  url: "https://github.com/openclaw/openclaw/pull/103469",
  state: "open",
  ...overrides,
});

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

const loadChecks = (checkRuns: Record<string, unknown>[], laterStatus?: number) => {
  vi.stubGlobal("fetch", paginatedChecksFetch(checkRuns, laterStatus));
  return load();
};

describe("parseGitHubRemoteUrl", () => {
  it.each([
    [
      "https://ghe.example.test/acme/private-repo.git",
      "ghe.example.test",
      { owner: "acme", repo: "private-repo" },
    ],
    [
      "git@ghe.example.test:acme/private-repo.git",
      "ghe.example.test",
      { owner: "acme", repo: "private-repo" },
    ],
    ["https://github.com/acme/private-repo.git", "ghe.example.test", null],
    ["https://gitlab.com/openclaw/openclaw.git", undefined, null],
    ["git@github.com:openclaw", undefined, null],
    ["https://github.com/openclaw/openclaw/extra", undefined, null],
    ["/local/path/repo.git", undefined, null],
  ] as const)("resolves GitHub remote %s against host %s", (remote, host, expected) => {
    expect(parseGitHubRemoteUrl(remote, host)).toEqual(expected);
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
    vi.unstubAllGlobals();
  });

  const forkOwner = "PratikRai0101";
  const forkPull = (number: number, head = { owner: forkOwner, repo: "openclaw" }) =>
    pullListItem({
      number,
      html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
      head: {
        sha: "b".repeat(40),
        ref: context.branch,
        repo: { full_name: `${head.owner}/${head.repo}` },
      },
    });
  const route = (match: string, response: () => Response | Promise<Response>) => ({
    match,
    response,
  });
  const pullsRoute = (response: () => Response | Promise<Response>) =>
    route("/pulls?head=", response);
  const repoRoute = () => route("/repos/openclaw/openclaw", () => githubJson({ fork: false }));
  const forkRoutes = (
    number: number,
    head = { owner: forkOwner, repo: "openclaw" },
    originPull?: Record<string, unknown>,
  ) => [
    route("/repos/openclaw/openclaw/pulls?head=openclaw%3A", () =>
      githubJson(originPull ? [originPull] : []),
    ),
    route(`/repos/openclaw/openclaw/pulls?head=${head.owner}%3A`, () =>
      githubJson([forkPull(number, head)]),
    ),
    route(`/repos/openclaw/openclaw/pulls/${number}`, () =>
      githubJson({ additions: 4, deletions: 3, changed_files: 2 }),
    ),
    route("/repos/openclaw/openclaw/commits/", () =>
      githubJson({ total_count: 0, check_runs: [] }),
    ),
    route("/repos/openclaw/openclaw", () => githubJson({ fork: false })),
  ];
  const loadFork = (candidates = [{ owner: forkOwner, repo: "openclaw" }]) =>
    load({}, { resolveGitContext: async () => ({ ...context, forkHeadCandidates: candidates }) });

  it("returns chips with diff counts and check rollup for open PRs", async () => {
    const fetchImpl = routedFetch([
      pullsRoute(() => githubJson([pullListItem()])),
      route("/pulls/103469", () => githubJson({ additions: 4, deletions: 3, changed_files: 2 })),
      route("/check-runs", () =>
        githubJson({
          total_count: 2,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "skipped" },
          ],
        }),
      ),
    ]);
    vi.stubGlobal("fetch", fetchImpl);

    expect(await load()).toEqual({
      repository: { owner: "openclaw", repo: "openclaw" },
      pullRequests: [
        chip({
          additions: 4,
          deletions: 3,
          changedFiles: 2,
          checks: { state: "passing", passed: 1, failed: 0, skipped: 1, running: 0 },
          checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
        }),
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
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const first = await load({}, { cacheSignal: cacheLifetime.signal });

      vi.stubEnv("GH_TOKEN", "");
      await expect(load({}, { cacheSignal: cacheLifetime.signal })).resolves.toEqual({
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

    // GitHub's stale conclusion invalidates a run; it must not roll up as green.
    for (const [status, conclusion, state, failed, running] of [
      ["in_progress", null, "pending", 0, 1],
      ["completed", "timed_out", "failing", 1, 0],
      ["completed", "stale", "pending", 0, 1],
    ] as const) {
      checkRuns[0] = { status, conclusion };
      const result = await loadChecks(checkRuns);
      expect(result.pullRequests[0]?.checks).toEqual({
        state,
        passed: 1,
        failed,
        skipped: 0,
        running,
      });
      vi.advanceTimersByTime(10 * 60_000);
    }
  });

  it("returns the complete rollup for verbose check output", async () => {
    const count = 100;
    const result = await loadChecks(
      Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        status: "completed",
        conclusion: index === count - 1 ? "failure" : "success",
        output: { title: "Synthetic check", summary: "x".repeat(3_000) },
      })),
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
    const result = await loadChecks(
      Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        status: "completed",
        conclusion: "success",
      })),
      403,
    );

    expect(result.pullRequests[0]?.number).toBe(103469);
    expect(result.pullRequests[0]?.checks).toBeUndefined();
    expect(result.rateLimited).toBe(false);
  });

  it.each([
    { count: 0, passed: undefined },
    { count: 1_000, passed: 1_000 },
    { count: 1_001, passed: undefined },
  ])("bounds check collection for $count runs", async ({ count, passed }) => {
    const fetchImpl = paginatedChecksFetch(
      Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        status: "completed",
        conclusion: "success",
      })),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const result = await load();

    expect(result.pullRequests[0]?.checks?.passed).toBe(passed);
    expect(
      fetchImpl.mock.calls.filter(([url]) => requestUrl(url).includes("/check-runs")).length,
    ).toBeLessThanOrEqual(10);
  });

  it("falls back to the fork parent repo when the origin repo has no PRs", async () => {
    const fetchImpl = routedFetch([
      route("/repos/fork-owner/openclaw/pulls?head=", () => githubJson([])),
      route("/repos/fork-owner/openclaw", () =>
        githubJson({ fork: true, parent: { name: "openclaw", owner: { login: "openclaw" } } }),
      ),
      route("/repos/openclaw/openclaw/pulls?head=", () =>
        githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      ),
    ]);
    vi.stubGlobal("fetch", fetchImpl);

    const result = await load(
      {},
      { resolveGitContext: async () => ({ ...context, owner: "fork-owner" }) },
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
    const fetchImpl = routedFetch([
      pullsRoute(() =>
        limited
          ? rateLimitedResponse()
          : githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      ),
    ]);
    vi.stubGlobal("fetch", fetchImpl);

    const fresh = await load();
    expect(fresh.rateLimited).toBe(false);
    expect(fresh.repository).toEqual({ owner: "openclaw", repo: "openclaw" });

    limited = true;
    vi.advanceTimersByTime(91_000);
    const stale = await load();
    expect(stale.rateLimited).toBe(true);
    expect(stale.pullRequests).toEqual(fresh.pullRequests);
    expect(stale.repository).toEqual(fresh.repository);

    const callsDuringBackoff = fetchImpl.mock.calls.length;
    const explicitRefresh = await load({ refresh: true });
    expect(explicitRefresh).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsDuringBackoff);

    vi.advanceTimersByTime(61_000);
    const stillBackedOff = await load();
    expect(stillBackedOff).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsDuringBackoff);
  });

  it("returns no chips without a git context and spends no quota", async () => {
    const fetchImpl = routedFetch([]);
    vi.stubGlobal("fetch", fetchImpl);
    const result = await load({}, { resolveGitContext: async () => null });
    expect(result).toEqual({ pullRequests: [], rateLimited: false });
    expect(fetchImpl.mock.calls).toHaveLength(0);
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
    vi.advanceTimersByTime(60_000);
    additions = 5;
    expect((await loadSession("agent:main:a")).branch?.additions).toBe(4);
    expect(localGitReads()).toHaveLength(2);
    expect(fetchImpl.mock.calls).toHaveLength(githubRequests);

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
      resolve: (root) => ({ ...context, branch, root, defaultBranch: "main" }),
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

  it("queues one forced refresh behind an ordinary in-flight lookup", async () => {
    const { promise: initialPulls, resolve: resolveInitialPulls } = createDeferred<Response>();
    const { promise: initialPullStarted, resolve: signalInitialPullStarted } = createDeferred();
    let pullListCalls = 0;
    vi.stubGlobal(
      "fetch",
      routedFetch([
        pullsRoute(() => {
          pullListCalls += 1;
          if (pullListCalls === 1) {
            signalInitialPullStarted();
            return initialPulls;
          }
          return githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]);
        }),
        repoRoute(),
      ]),
    );

    const initial = load();
    await initialPullStarted;
    const forcedRefresh = load({ refresh: true });
    await Promise.resolve();
    const ordinaryFollower = load();
    const duplicateForcedRefresh = load({ refresh: true });

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
    let hasPull = false;
    const routes = [
      pullsRoute(() => githubJson(hasPull ? [pullListItem({ user: { login: "octocat" } })] : [])),
      route("/pulls/103469", rateLimitedResponse),
      route("/check-runs", rateLimitedResponse),
      repoRoute(),
    ];
    vi.stubGlobal("fetch", routedFetch(routes));

    const beforePublication = await load();
    expect(beforePublication.pullRequests).toEqual([]);
    expect(beforePublication.branch).toBeDefined();
    hasPull = true;

    const result = await load({ refresh: true });

    expect(result.rateLimited).toBe(true);
    expect(result.branch).toBeUndefined();
    expect(result.pullRequests).toEqual([chip({ author: { login: "octocat" } })]);

    // Outage outlives the rate-limit cache window and now even the list
    // fetch 429s: the proven chips must survive as the last-known fallback.
    routes.length = 0;
    routes.push(pullsRoute(rateLimitedResponse));
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    const stillLimited = await load();
    expect(stillLimited.rateLimited).toBe(true);
    expect(stillLimited.pullRequests.map((item) => item.number)).toEqual([103469]);
  });

  it("finds a renamed fork without changing the base repository", async () => {
    const head = { owner: "lonexreb", repo: "paloa-claw" };
    vi.stubGlobal("fetch", routedFetch(forkRoutes(183571, head)));
    const result = await loadFork([head]);
    expect(result.repository).toEqual({ owner: "openclaw", repo: "openclaw" });
    expect(result.pullRequests.map((pull) => pull.number)).toEqual([183571]);
  });

  it("continues fork discovery when the origin query returns another head repository", async () => {
    const origin = forkPull(900001, { owner: "openclaw", repo: "another-repository" });
    vi.stubGlobal("fetch", routedFetch(forkRoutes(183696, undefined, origin)));
    const result = await loadFork();
    expect(result.pullRequests.map((pull) => pull.number)).toEqual([183696]);
  });

  it("rejects a same-owner head from another repository", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch(forkRoutes(183696, { owner: forkOwner, repo: "another-repository" })),
    );
    expect((await loadFork()).pullRequests).toEqual([]);
  });

  it("invalidates cached fork lookups when the candidate repository changes", async () => {
    vi.stubGlobal("fetch", routedFetch(forkRoutes(183535)));
    expect((await loadFork([])).pullRequests).toEqual([]);
    expect((await loadFork()).pullRequests.map((pull) => pull.number)).toEqual([183535]);
    const renamed = [{ owner: forkOwner, repo: "renamed-openclaw" }];
    expect((await loadFork(renamed)).pullRequests).toEqual([]);
  });
});
