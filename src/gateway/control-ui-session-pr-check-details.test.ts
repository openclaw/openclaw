import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import { loadControlUiSessionPullRequestChecks } from "./control-ui-session-pr-check-details.js";
import { githubJson, pullListItem, requestUrl } from "./control-ui-session-prs.test-support.js";

const headSha = "a".repeat(40);
const target = {
  sessionKey: "agent:main:ci",
  owner: "openclaw",
  repo: "openclaw",
  number: 103469,
  headSha,
};
const base = "https://api.github.com/repos/openclaw/openclaw";
const chip: ControlUiSessionPullRequest = {
  ...target,
  branch: "feature",
  title: "CI details",
  url: "https://github.com/openclaw/openclaw/pull/103469",
  state: "open",
};
let scope = 0;

function check(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: "check-" + id,
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    app: { slug: "github-actions" },
    check_suite: { id: 17 },
    details_url: "https://github.com/openclaw/openclaw/actions/runs/23/job/" + (id + 1000),
    started_at: "2026-09-14T03:00:00Z",
    completed_at: "2026-09-14T03:00:10Z",
    ...overrides,
  };
}
function job(checkId: number, overrides: Record<string, unknown> = {}) {
  return {
    id: checkId + 1000,
    run_id: 23,
    run_attempt: 2,
    head_sha: headSha,
    check_run_url: base + "/check-runs/" + checkId,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-14T03:00:00Z",
    completed_at: "2026-09-14T03:00:10Z",
    steps: [
      { number: 3, name: "Complete job", status: "completed", conclusion: "success" },
      { number: 1, name: "Set up", status: "completed", conclusion: "success" },
      { number: 2, name: "Test", status: "completed", conclusion: "success" },
    ],
    ...overrides,
  };
}

function harness() {
  const state = {
    checks: [check(1)],
    jobs: [job(1)],
    upstreamHead: headSha,
    status: 200,
    jobsStatus: 200,
    secondJobPageStatus: 200,
    runHead: headSha,
    snapshot: { pullRequests: [chip], rateLimited: false } as ControlUiSessionPullRequests,
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(requestUrl(input));
    if (state.status !== 200) {
      const response = githubJson({ message: "do not expose upstream diagnostics" }, state.status);
      if (state.status === 429) {
        response.headers.set("retry-after", "120");
      }
      return response;
    }
    if (url.pathname.endsWith("/pulls/103469")) {
      return githubJson(pullListItem({ head: { sha: state.upstreamHead } }));
    }
    const page = Number(url.searchParams.get("page"));
    const paginated = (field: string, rows: unknown[]) =>
      githubJson({ total_count: rows.length, [field]: rows.slice((page - 1) * 100, page * 100) });
    if (url.pathname.endsWith("/check-runs")) {
      expect(url.searchParams.get("filter")).toBe("latest");
      return paginated("check_runs", state.checks);
    }
    if (url.pathname.endsWith("/actions/runs")) {
      expect(url.searchParams.get("head_sha")).toBe(headSha);
      expect(url.searchParams.get("check_suite_id")).toBe("17");
      return githubJson({
        total_count: 1,
        workflow_runs: [{ id: 23, check_suite_id: 17, head_sha: state.runHead, run_attempt: 2 }],
      });
    }
    if (url.pathname.endsWith("/jobs")) {
      expect(url.searchParams.get("filter")).toBe("all");
      const status = page > 1 ? state.secondJobPageStatus : state.jobsStatus;
      return status !== 200 ? githubJson({}, status) : paginated("jobs", state.jobs);
    }
    throw new Error("Unexpected route: " + url.href);
  });
  const deps = {
    sessionScope: "ci-test-" + ++scope,
    assertCurrent: vi.fn(),
    fetchImpl,
    loadPullRequests: vi.fn(async () => state.snapshot),
  };
  return { state, deps, load: () => loadControlUiSessionPullRequestChecks(target, deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T04:00:00Z"));
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("session PR CI details", () => {
  it("paginates checks and Actions jobs, joins check_run_url instead of IDs, and orders steps", async () => {
    const h = harness();
    h.state.checks = Array.from({ length: 101 }, (_, i) =>
      check(i + 1, i === 100 ? { conclusion: "failure" } : {}),
    );
    h.state.jobs = Array.from({ length: 101 }, (_, i) =>
      job(i + 1, i === 100 ? { conclusion: "failure" } : {}),
    );
    const result = await h.load();
    expect(result.status).toBe("ready");
    expect(result.checks).toHaveLength(101);
    expect(result.checks[0]).toMatchObject({
      id: 101,
      state: "failed",
      source: "actions",
      detailsUrl: "https://github.com/openclaw/openclaw/actions/runs/23/job/1101",
    });
    expect(result.checks[0]?.steps?.map((step) => step.number)).toEqual([1, 2, 3]);
    expect(
      h.deps.fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes("/jobs?")),
    ).toHaveLength(2);
    expect(h.deps.fetchImpl.mock.calls).toHaveLength(9);
  });

  it("keeps non-Actions checks distinct and skips Actions calls for skipped-only suites", async () => {
    const h = harness();
    h.state.checks = [
      check(1, { conclusion: "skipped" }),
      check(2, {
        app: { slug: "external-ci" },
        status: "queued",
        conclusion: null,
        details_url: "https://ci.example.test/build/2",
      }),
    ];
    const result = await h.load();
    expect(result.checks.map((row) => [row.id, row.source, row.state, row.steps])).toEqual([
      [2, "check", "running", undefined],
      [1, "actions", "skipped", undefined],
    ]);
    expect(result.checks[0]?.detailsUrl).toBe("https://ci.example.test/build/2");
    expect(
      h.deps.fetchImpl.mock.calls.some(([input]) => requestUrl(input).includes("/actions/")),
    ).toBe(false);
  });

  it("uses only current check identities while retaining successful earlier-attempt jobs", async () => {
    const h = harness();
    h.state.checks = [
      check(2, { name: "rerun", status: "in_progress", conclusion: null }),
      check(3, { name: "retained" }),
    ];
    h.state.jobs = [
      job(1, { run_attempt: 1, name: "rerun", conclusion: "failure" }),
      job(2, {
        status: "in_progress",
        conclusion: null,
        steps: [{ number: 1, name: "Current attempt", status: "in_progress", conclusion: null }],
      }),
      job(3, { run_attempt: 1 }),
    ];
    const result = await h.load();
    expect(result.status).toBe("ready");
    expect(result.checks.map((row) => row.id)).toEqual([2, 3]);
    expect(result.checks[0]?.steps?.[0]?.name).toBe("Current attempt");
    expect(result.checks[1]?.steps).toHaveLength(3);
    h.state.checks = [check(4, { name: "rerun", conclusion: "failure" })];
    h.state.jobs = [job(4, { conclusion: "failure" })];
    vi.advanceTimersByTime(30_001);
    const rerun = await h.load();
    expect(rerun.checks.map((row) => row.id)).toEqual([4]);
  });

  it.each(["foreign repository", "missing join", "wrong head", "duplicate steps"])(
    "does not attach steps for %s",
    async (failure) => {
      const h = harness();
      if (failure === "foreign repository") {
        h.state.jobs = [
          job(1, { check_run_url: "https://api.github.com/repos/other/repo/check-runs/1" }),
        ];
      }
      if (failure === "missing join") {
        h.state.jobs = [job(2, { id: 1 })];
      }
      if (failure === "wrong head") {
        h.state.runHead = "b".repeat(40);
      }
      if (failure === "duplicate steps") {
        h.state.jobs = [
          job(1, {
            steps: [
              { number: 1, name: "a", status: "completed" },
              { number: 1, name: "b", status: "completed" },
            ],
          }),
        ];
      }
      const result = await h.load();
      expect(result.status).toBe("stale");
      expect(result.checks[0]?.steps).toBeUndefined();
      expect(result.error).toBeTruthy();
    },
  );

  it("does not treat a failed later jobs page as a complete job inventory", async () => {
    const h = harness();
    h.state.checks = Array.from({ length: 101 }, (_, i) => check(i + 1));
    h.state.jobs = Array.from({ length: 101 }, (_, i) => job(i + 1));
    h.state.secondJobPageStatus = 403;
    const result = await h.load();
    expect(result.status).toBe("stale");
    expect(result.checks).toHaveLength(101);
    expect(result.checks.every((row) => row.steps === undefined)).toBe(true);
    expect(result.rateLimited).toBe(false);
  });

  it("coalesces repeated requests and respects the upstream retry window with stale data", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.load(), h.load()]);
    expect(a).toEqual(b);
    expect(h.deps.fetchImpl).toHaveBeenCalledTimes(6);
    a.checks.splice(0);
    expect((await h.load()).checks).toHaveLength(1);
    h.state.status = 429;
    vi.advanceTimersByTime(30_001);
    const stale = await h.load();
    expect(stale).toMatchObject({ status: "stale", rateLimited: true, retryAfterMs: 120_000 });
    const calls = h.deps.fetchImpl.mock.calls.length;
    vi.advanceTimersByTime(90_000);
    expect((await h.load()).status).toBe("stale");
    expect(h.deps.fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it("does not reuse details across session generations or credential selections", async () => {
    const h = harness();
    await h.load();
    h.state.status = 404;
    const nextSession = await loadControlUiSessionPullRequestChecks(target, {
      ...h.deps,
      sessionScope: "next-session-" + ++scope,
    });
    expect(nextSession).toMatchObject({ status: "unavailable", checks: [] });
    vi.stubEnv("GH_TOKEN", "another-ci-credential");
    expect(await h.load()).toMatchObject({ status: "unavailable", checks: [] });
  });

  it("rejects a client-selected PR/head absent from the session without fetching details", async () => {
    const h = harness();
    expect(
      await loadControlUiSessionPullRequestChecks({ ...target, number: 999 }, h.deps),
    ).toMatchObject({ status: "unavailable", checks: [] });
    expect(
      await loadControlUiSessionPullRequestChecks({ ...target, headSha: "b".repeat(40) }, h.deps),
    ).toMatchObject({ status: "unavailable", checks: [] });
    expect(h.deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("discards old-head details if the PR advances while Actions jobs are loading", async () => {
    const h = harness();
    const fetch = expectDefined(
      h.deps.fetchImpl.getMockImplementation(),
      "CI fetch implementation",
    );
    h.deps.fetchImpl.mockImplementation(async (input, init) => {
      const response = await fetch(input, init);
      if (requestUrl(input).includes("/jobs?")) {
        h.state.upstreamHead = "b".repeat(40);
      }
      return response;
    });
    expect(await h.load()).toMatchObject({
      status: "unavailable",
      checks: [],
      error: expect.stringContaining("head changed"),
    });
  });

  it("rejects a rerun that replaces the current check inventory mid-request", async () => {
    const h = harness();
    const fetch = expectDefined(
      h.deps.fetchImpl.getMockImplementation(),
      "CI fetch implementation",
    );
    h.deps.fetchImpl.mockImplementation(async (input, init) => {
      const response = await fetch(input, init);
      if (requestUrl(input).includes("/jobs?")) {
        h.state.checks = [check(2)];
      }
      return response;
    });
    expect(await h.load()).toMatchObject({
      status: "unavailable",
      checks: [],
      error: expect.stringContaining("rerun"),
    });
  });

  it("bounds distinct concurrent detail loads without multiplying GitHub requests", async () => {
    const h = harness();
    const gate = createDeferred<Response>();
    const started = createDeferred();
    const fetch = expectDefined(
      h.deps.fetchImpl.getMockImplementation(),
      "CI fetch implementation",
    );
    let waiting = 0;
    h.deps.fetchImpl.mockImplementation(async (input, init) => {
      if (requestUrl(input).includes("/jobs?")) {
        if (++waiting === 4) {
          started.resolve();
        }
        return gate.promise.then((response) => response.clone());
      }
      return fetch(input, init);
    });
    const pending = Array.from({ length: 4 }, (_, i) =>
      loadControlUiSessionPullRequestChecks(target, {
        ...h.deps,
        sessionScope: h.deps.sessionScope + "-" + i,
      }),
    );
    await started.promise;
    const busy = await h.load();
    expect(busy).toMatchObject({ status: "unavailable", retryAfterMs: 5_000, checks: [] });
    gate.resolve(githubJson({ total_count: 1, jobs: h.state.jobs }));
    expect((await Promise.all(pending)).every((value) => value.status === "ready")).toBe(true);
  });

  it("clears stale private details after access is revoked", async () => {
    const h = harness();
    await h.load();
    h.state.status = 403;
    vi.advanceTimersByTime(30_001);
    expect(await h.load()).toMatchObject({ status: "unavailable", checks: [] });
    h.state.status = 503;
    vi.advanceTimersByTime(30_001);
    expect(await h.load()).toMatchObject({ status: "unavailable", checks: [] });
  });

  it("rejects repository redirects without dispatching credentials to a new target", async () => {
    const h = harness();
    h.deps.fetchImpl.mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repos/other/repo/pulls/103469" },
      }),
    );
    expect(await h.load()).toMatchObject({
      status: "unavailable",
      checks: [],
      error: expect.stringContaining("repository changed"),
    });
    expect(h.deps.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rechecks each caller's live authority after a coalesced response", async () => {
    const h = harness();
    const gate = createDeferred<Response>();
    const started = createDeferred();
    const fetch = expectDefined(
      h.deps.fetchImpl.getMockImplementation(),
      "CI fetch implementation",
    );
    h.deps.fetchImpl.mockImplementation(async (input, init) => {
      if (requestUrl(input).includes("/jobs?")) {
        started.resolve();
        return gate.promise;
      }
      return fetch(input, init);
    });
    const first = h.load();
    const second = loadControlUiSessionPullRequestChecks(target, {
      ...h.deps,
      assertCurrent: () => {},
    });
    await started.promise;
    h.deps.assertCurrent.mockImplementation(() => {
      throw new Error("session generation changed");
    });
    gate.resolve(githubJson({ total_count: 1, jobs: h.state.jobs }));
    await expect(first).rejects.toThrow("session generation changed");
    expect((await second).status).toBe("ready");
  });
});
