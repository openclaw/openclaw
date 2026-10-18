import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ControlUiSessionPullRequest } from "./control-ui-contract.js";
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

const completed = {
  status: "completed",
  conclusion: "success",
  started_at: "2026-09-14T03:00:00Z",
  completed_at: "2026-09-14T03:00:10Z",
};

function check(id: number, overrides: Record<string, unknown> = {}, host = "github.com") {
  return {
    id,
    name: "check-" + id,
    ...completed,
    head_sha: headSha,
    app: { slug: "github-actions" },
    check_suite: { id: 17 },
    details_url: `https://${host}/openclaw/openclaw/actions/runs/23/job/${id + 1000}`,
    ...overrides,
  };
}
function step(number: number, name: string, status = "completed", conclusion?: string | null) {
  return { number, name, status, conclusion };
}
function job(checkId: number, overrides: Record<string, unknown> = {}, api = base) {
  return {
    id: checkId + 1000,
    run_id: 23,
    run_attempt: 2,
    head_sha: headSha,
    check_run_url: api + "/check-runs/" + checkId,
    ...completed,
    steps: [
      step(3, "Complete job", "completed", "success"),
      step(1, "Set up", "completed", "success"),
      step(2, "Test", "completed", "success"),
    ],
    ...overrides,
  };
}

function harness(host = "github.com") {
  const api = host === "github.com" ? base : `https://${host}/api/v3/repos/openclaw/openclaw`;
  const pullUrl = chip.url.replace("github.com", host);
  if (host !== "github.com") {
    setRuntimeConfigSnapshot({
      gateway: {
        github: { host, apiBaseUrl: `https://${host}/api/v3` },
        controlUi: { github: { host, token: "synthetic-enterprise-token" } },
      },
    });
  }
  const state = {
    checks: [check(1, {}, host)],
    jobs: [job(1, {}, api)],
    status: 200,
    secondJobPageStatus: 200,
    runHead: headSha,
  };
  const fetchResponse: typeof fetch = async (input, options) => {
    if (host !== "github.com") {
      expect(requestUrl(input).startsWith(api)).toBe(true);
      expect(new Headers(options?.headers).get("Authorization")).toBe(
        "Bearer synthetic-enterprise-token",
      );
    }
    const url = new URL(requestUrl(input));
    if (state.status !== 200) {
      const response = githubJson({ message: "do not expose upstream diagnostics" }, state.status);
      if (state.status === 429) {
        response.headers.set("retry-after", "120");
      }
      return response;
    }
    if (url.pathname.endsWith("/pulls/103469")) {
      return githubJson(pullListItem({ html_url: pullUrl }));
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
      const status = page > 1 ? state.secondJobPageStatus : 200;
      return status !== 200 ? githubJson({}, status) : paginated("jobs", state.jobs);
    }
    throw new Error("Unexpected route: " + url.href);
  };
  const snapshot = { pullRequests: [{ ...chip, url: pullUrl }], rateLimited: false };
  const fetchImpl = vi.fn(fetchResponse);
  vi.stubGlobal("fetch", fetchImpl);
  const deps = {
    sessionScope: "ci-test-" + ++scope,
    assertCurrent: vi.fn(),
    loadPullRequests: vi.fn(async () => snapshot),
  };
  return {
    api,
    host,
    state,
    ...deps,
    fetchImpl,
    fetchResponse,
    load: (
      params: Partial<typeof target> = {},
      overrides: Partial<Parameters<typeof loadControlUiSessionPullRequestChecks>[1]> = {},
    ) => loadControlUiSessionPullRequestChecks({ ...target, ...params }, { ...deps, ...overrides }),
  };
}

let h: ReturnType<typeof harness>;
const unavailable = { status: "unavailable", checks: [] };
function paginate(failing = false) {
  const verdict = (i: number) => (failing && i === 100 ? { conclusion: "failure" } : {});
  h.state.checks = Array.from({ length: 101 }, (_, i) => check(i + 1, verdict(i), h.host));
  h.state.jobs = Array.from({ length: 101 }, (_, i) => job(i + 1, verdict(i), h.api));
}
function holdJobs(readers = 1) {
  const clone = readers > 1;
  let waiting = 0;
  const gate = createDeferred<Response>();
  const started = createDeferred();
  h.fetchImpl.mockImplementation(async (input, init) => {
    if (!requestUrl(input).includes("/jobs?")) {
      return h.fetchResponse(input, init);
    }
    if (++waiting === readers) {
      started.resolve();
    }
    return clone ? gate.promise.then((response) => response.clone()) : gate.promise;
  });
  return {
    started: started.promise,
    release: () => gate.resolve(githubJson({ total_count: 1, jobs: h.state.jobs })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T04:00:00Z"));
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  h = harness();
});
afterEach(() => {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["github.com", "ghe.example.test"])(
  "paginates and joins checks on the session host %s",
  async (host) => {
    h = harness(host);
    paginate(true);
    const result = await h.load();
    expect(result.status).toBe("ready");
    expect(result.checks).toHaveLength(101);
    expect(result.checks[0]).toMatchObject({
      id: 101,
      state: "failed",
      source: "actions",
      detailsUrl: `https://${host}/openclaw/openclaw/actions/runs/23/job/1101`,
    });
    expect(result.checks[0]?.steps?.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(
      h.fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes("/jobs?")),
    ).toHaveLength(2);
    expect(h.fetchImpl.mock.calls).toHaveLength(6);
  },
);

it("separates non-Actions checks and skips skipped-only Actions suites", async () => {
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
  expect(h.fetchImpl.mock.calls.some(([input]) => requestUrl(input).includes("/actions/"))).toBe(
    false,
  );
});

it("joins current checks and retains successful earlier-attempt jobs", async () => {
  h.state.checks = [
    check(2, { name: "rerun", status: "in_progress", conclusion: null }),
    check(3, { name: "retained" }),
  ];
  h.state.jobs = [
    job(1, { run_attempt: 1, name: "rerun", conclusion: "failure" }),
    job(2, {
      status: "in_progress",
      conclusion: null,
      steps: [step(1, "Current attempt", "in_progress", null)],
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
  expect((await h.load()).checks.map((row) => row.id)).toEqual([4]);
});

it.each([
  [
    "foreign repository",
    { jobs: [job(1, { check_run_url: "https://api.github.com/repos/other/repo/check-runs/1" })] },
  ],
  ["missing join", { jobs: [job(2, { id: 1 })] }],
  ["wrong head", { runHead: "b".repeat(40) }],
  ["duplicate steps", { jobs: [job(1, { steps: [step(1, "a"), step(1, "b")] })] }],
] as const)("does not attach steps for %s", async (_failure, patch) => {
  Object.assign(h.state, patch);
  const result = await h.load();
  expect(result.status).toBe("stale");
  expect(result.checks[0]?.steps).toBeUndefined();
  expect(result.error).toBeTruthy();
});

it("does not treat a failed later jobs page as a complete job inventory", async () => {
  paginate();
  h.state.secondJobPageStatus = 403;
  const result = await h.load();
  expect(result.checks).toHaveLength(101);
  expect(result.checks.every((row) => row.steps === undefined)).toBe(true);
  expect(result).toMatchObject({ status: "stale", rateLimited: false });
});

it("coalesces reads and respects the retry window with stale data", async () => {
  const [a, b] = await Promise.all([h.load(), h.load()]);
  expect(a).toEqual(b);
  expect(h.fetchImpl).toHaveBeenCalledTimes(4);
  a.checks.splice(0);
  expect((await h.load()).checks).toHaveLength(1);
  h.state.status = 429;
  vi.advanceTimersByTime(30_001);
  const stale = await h.load();
  expect(stale).toMatchObject({ status: "stale", rateLimited: true, retryAfterMs: 120_000 });
  const calls = h.fetchImpl.mock.calls.length;
  vi.advanceTimersByTime(90_000);
  expect((await h.load()).status).toBe("stale");
  expect(h.fetchImpl).toHaveBeenCalledTimes(calls);
});

it("does not reuse details across session generations or credential selections", async () => {
  await h.load();
  h.state.status = 404;
  const nextSession = await h.load({}, { sessionScope: "next-session-" + ++scope });
  expect(nextSession).toMatchObject(unavailable);
  vi.stubEnv("GH_TOKEN", "another-ci-credential");
  expect(await h.load()).toMatchObject(unavailable);
});

it("rejects unbound PRs and heads without fetching details", async () => {
  expect(await h.load({ number: 999 })).toMatchObject(unavailable);
  expect(await h.load({ headSha: "b".repeat(40) })).toMatchObject(unavailable);
  expect(h.fetchImpl).not.toHaveBeenCalled();
});

it("bounds distinct concurrent loads without extra GitHub requests", async () => {
  const jobs = holdJobs(4);
  const pending = Array.from({ length: 4 }, (_, i) =>
    h.load({}, { sessionScope: h.sessionScope + "-" + i }),
  );
  await jobs.started;
  const busy = await h.load();
  expect(busy).toMatchObject({ status: "unavailable", retryAfterMs: 5_000, checks: [] });
  jobs.release();
  expect((await Promise.all(pending)).every((value) => value.status === "ready")).toBe(true);
});

it("clears stale private details after access is revoked", async () => {
  await h.load();
  h.state.status = 403;
  vi.advanceTimersByTime(30_001);
  expect(await h.load()).toMatchObject(unavailable);
  h.state.status = 503;
  vi.advanceTimersByTime(30_001);
  expect(await h.load()).toMatchObject(unavailable);
});

it("rejects repository redirects without credential dispatch", async () => {
  h.fetchImpl.mockResolvedValue(
    new Response(null, {
      status: 301,
      headers: { location: "https://api.github.com/repos/other/repo/pulls/103469" },
    }),
  );
  expect(await h.load()).toMatchObject({
    ...unavailable,
    error: expect.stringContaining("repository changed"),
  });
  expect(h.fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "rechecks live readers of coalesced details (remaining reader=%s)",
  async (remainingReader) => {
    const jobs = holdJobs();
    const first = h.load();
    let active = true;
    const second = h.load(
      {},
      {
        assertCurrent: () => {
          if (!active) {
            throw new Error("Second reader retired");
          }
        },
      },
    );
    await jobs.started;
    active = remainingReader;
    h.assertCurrent.mockImplementation(() => {
      throw new Error("session generation changed");
    });
    jobs.release();
    await expect(first).rejects.toThrow("session generation changed");
    if (remainingReader) {
      expect((await second).status).toBe("ready");
    } else {
      await expect(second).rejects.toThrow("Second reader retired");
      expect(h.fetchImpl).toHaveBeenCalledTimes(4);
    }
  },
);
