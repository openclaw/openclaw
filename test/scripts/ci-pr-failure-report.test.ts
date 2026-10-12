import { afterEach, describe, expect, it, vi } from "vitest";
import { formatFailureReport, reportPrFailures } from "../../scripts/ci-pr-failure-report.mjs";

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

function fixture(rows: ReturnType<typeof job>[], currentRun = run) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const path = new URL(url).pathname.replace(`/repos/${repository}`, "");
    let body;
    if (path === "/actions/runs/100") {
      body = currentRun;
    } else if (/^\/actions\/runs\/100\/attempts\/[12]\/jobs$/.test(path)) {
      body = { total_count: rows.length, jobs: rows };
    } else if (path === "/actions/workflows/ci.yml/runs") {
      body = { workflow_runs: [mainRun] };
    } else if (path === "/actions/runs/200/attempts/1/jobs") {
      const jobs = [job(20, "build-artifacts", "failure"), job(21, "checks-ui", "success")].map(
        (entry) => ({ ...entry, run_id: 200 }),
      );
      body = { total_count: jobs.length, jobs };
    } else {
      throw new Error(`Unexpected API request ${path}`);
    }
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe("completed PR failure reporting", () => {
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
    const report = await reportPrFailures(options);
    expect(report.failures).toMatchObject([
      { job: "build-artifacts", class: "pre-existing", mainRunId: 200, mainJobId: 20 },
      { job: "checks-ui", class: "new", mainRunId: 200, mainJobId: 21 },
      { job: "platform-only", class: "unknown", mainRunId: 200, mainJobId: null },
    ]);
    expect(report.knownMainRed).toBe(false);
    expect(report.failureJobId).toBe("2");
    const summary = formatFailureReport(report, options);
    expect(summary).toContain(
      "| [build-artifacts](https://github.com/openclaw/openclaw/actions/runs/100/job/2) | failure | **pre-existing** |",
    );
    expect(summary).toContain("https://github.com/openclaw/openclaw/actions/runs/200/job/20");
    expect(summary).toContain("**new**");
    expect(summary).toContain("**unknown**");
  });

  it("does not grant the first-attempt allowance on a retry", async () => {
    const retry = { ...run, run_attempt: 2 };
    fixture([], retry);
    const report = await reportPrFailures({ ...options, runAttempt: 2 });
    expect(report).toMatchObject({ failures: [], knownMainRed: false, failureJobId: "" });
  });

  it("waits for all validation jobs and rejects mismatched run identity", async () => {
    fixture([job(1, "checks-ui", null)]);
    await expect(reportPrFailures(options)).rejects.toThrow("not all completed");
    fixture([], { ...run, head_sha: "b".repeat(40) });
    await expect(reportPrFailures(options)).rejects.toThrow("identity changed");
  });

  it("escapes job-controlled table text", () => {
    const summary = formatFailureReport(
      {
        jobs: [job(1, "bad")],
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
    expect(summary).toContain("&#91;bad&#93;&#124;&lt;br&gt; next");
    expect(summary).toContain("a&#124;b");
  });
});
