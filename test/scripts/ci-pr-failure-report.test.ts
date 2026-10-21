import { afterEach, expect, it, vi } from "vitest";
import { formatFailureReport, reportPrFailures } from "../../scripts/ci-pr-failure-report.mjs";
import {
  evaluateWorkflow,
  expectIncludes,
  readCiWorkflow,
  requiredWorkflowStep,
} from "./ci-workflow.test-support.js";

const repository = "openclaw/openclaw";
const headSha = "a".repeat(40);
const run = {
  id: 100,
  run_attempt: 1,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  head_sha: headSha,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};
const mainRun = {
  ...run,
  id: 200,
  run_number: 20,
  event: "schedule",
  status: "completed",
  head_branch: "main",
};
const job = (id: number, name: string, conclusion: string | null = "success") => ({
  id,
  name,
  run_id: 100,
  run_attempt: 1,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  steps: [],
});
const options = {
  repository,
  headRepository: repository,
  headSha,
  runId: 100,
  runAttempt: 1,
  pullRequestNumber: 7,
  token: "synthetic-token",
};
const report = (overrides: Record<string, unknown> = {}) =>
  reportPrFailures({ ...options, ...overrides });
const passedPrerequisites = { preflightResult: "success", securityFastResult: "success" };

function fixture(rows: ReturnType<typeof job>[], currentRun = run) {
  const mainJobs = [job(20, "build-artifacts", "failure"), job(21, "checks-ui")].map((entry) =>
    Object.assign(entry, { run_id: 200 }),
  );
  const responses: Record<string, unknown> = {
    "/actions/runs/100": currentRun,
    "/actions/runs/100/attempts/1/jobs": { total_count: rows.length, jobs: rows },
    "/actions/runs/100/attempts/2/jobs": { total_count: rows.length, jobs: rows },
    "/actions/workflows/ci.yml/runs": { workflow_runs: [mainRun] },
    "/actions/runs/200/attempts/1/jobs": { total_count: mainJobs.length, jobs: mainJobs },
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const path = new URL(url).pathname.replace(`/repos/${repository}`, "");
    if (!(path in responses)) {
      throw new Error(`Unexpected API request ${path}`);
    }
    return new Response(JSON.stringify(responses[path]));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  [repository, "c".repeat(40)],
  ["contributor/openclaw", "main"],
])("checks out trusted reporter code for %s despite a stale event base", (headRepository, ref) => {
  const checkout = requiredWorkflowStep(
    readCiWorkflow().jobs["pr-failure-report"].steps,
    "Checkout CI failure reporter",
  );
  expect(checkout.with.repository ?? repository).toBe(repository);
  expect(
    evaluateWorkflow(checkout.with.ref, {
      headRepository,
      sha: "c".repeat(40),
      githubEvent: {
        pull_request: {
          head: { repo: { full_name: headRepository }, sha: headSha },
          base: { ref: "main", sha: "b".repeat(40) },
        },
      },
    }),
  ).toBe(ref);
});
it("uses complete successful prerequisite results without enumerating jobs", async () => {
  const fetchMock = fixture([job(1, "checks-ui")]);
  const result = await report({
    ...passedPrerequisites,
    jobResults: ["success", "success", "success", "skipped"],
  });
  expect(result).toMatchObject({ failures: [], knownMainRed: false, failureJobId: "" });
  expect(formatFailureReport(result, options)).toContain("prerequisite results");
  expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    `/repos/${repository}/actions/runs/100`,
  ]);
});

it.each(["failure", "cancelled", "unknown", "", undefined])(
  "enumerates jobs when a prerequisite result is %s",
  async (result) => {
    const fetchMock = fixture([job(1, "checks-ui", "timed_out")]);
    const outcome = await report({
      ...passedPrerequisites,
      jobResults: ["success", "success", result],
    });
    expect(outcome).toMatchObject({
      failures: [{ job: "checks-ui", conclusion: "timed_out" }],
      knownMainRed: false,
      failureJobId: "1",
    });
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/attempts/1/jobs"))).toBe(true);
  },
);

it("reports every failure without cancellation and preserves a blocking gate result", async () => {
  fixture([
    job(1, "preflight"),
    job(2, "build-artifacts", "failure"),
    job(3, "checks-ui", "failure"),
    job(4, "platform-only", "timed_out"),
    job(5, "not-selected", "skipped"),
    job(6, "pr-failure-report", null),
    job(7, "openclaw/ci-gate", null),
  ]);
  const result = await report();
  expect(result).toMatchObject({
    failures: [
      { job: "build-artifacts", class: "pre-existing", mainRunId: 200, mainJobId: 20 },
      { job: "checks-ui", class: "new", mainRunId: 200, mainJobId: 21 },
      { job: "platform-only", class: "unknown", mainRunId: 200, mainJobId: null },
    ],
    knownMainRed: false,
    failureJobId: "2",
  });
  const summary = formatFailureReport(result, options);
  expectIncludes(summary, [
    "| [build-artifacts](https://github.com/openclaw/openclaw/actions/runs/100/job/2) | failure | **pre-existing** |",
    "https://github.com/openclaw/openclaw/actions/runs/200/job/20",
    "**new**",
    "**unknown**",
  ]);
});

it("does not grant the first-attempt allowance on a retry", async () => {
  const retry = { ...run, run_attempt: 2 };
  fixture([], retry);
  const result = await report({ runAttempt: 2 });
  expect(result).toMatchObject({ failures: [], knownMainRed: false, failureJobId: "" });
});

it("waits for all validation jobs and rejects mismatched run identity", async () => {
  fixture([job(1, "checks-ui", null)]);
  await expect(report()).rejects.toThrow("not all completed");
  fixture([], { ...run, head_sha: "b".repeat(40) });
  await expect(report()).rejects.toThrow("identity changed");
});

it("escapes job-controlled table text", () => {
  const summary = formatFailureReport(
    {
      jobs: [{ id: 1 }],
      failures: [
        {
          job: "[bad]|<br>\nnext",
          conclusion: "failure",
          class: "unknown",
          mainRunId: null,
          mainJobId: null,
          reason: "a|b",
        },
      ],
    },
    options,
  );
  expectIncludes(summary, ["&#91;bad&#93;&#124;&lt;br&gt; next", "a&#124;b"]);
});
