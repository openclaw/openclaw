import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectRunJobsFromPages,
  isRetryableGhJsonErrorMessage,
  parseRunTimingArgs,
  selectLatestMainPushCiRun,
  summarizeRunTimings,
  summarizeTrendTimings,
} from "../../scripts/ci-run-timings.mjs";

const timestamp = (time: string) => `2026-04-22T${time}Z`;
const completedRun = {
  conclusion: "success",
  createdAt: timestamp("10:00:00"),
  status: "completed",
  updatedAt: timestamp("10:01:30"),
};
const timingJob = (name: string, start: string, end: string, conclusion = "success") => ({
  name,
  conclusion,
  status: "completed",
  startedAt: timestamp(start),
  completedAt: timestamp(end),
});
const run = (databaseId: number, event: string, headSha: string) => ({
  databaseId,
  event,
  headSha,
});
const timingDefaults = {
  compareHours: 12,
  detailRuns: 100,
  explicitRunId: undefined,
  json: false,
  limit: 15,
  outputPath: null,
  recentLimit: null,
  trendHours: null,
  useLatestMain: false,
};
describe("scripts/ci-run-timings.mjs", () => {
  it("separates start delay from job duration without mislabeling dependency wait", () => {
    const summary = summarizeRunTimings(
      {
        ...completedRun,
        jobs: [
          timingJob("slow", "10:00:20", "10:01:20"),
          timingJob("queued", "10:00:50", "10:01:00"),
          timingJob("matrix.check_name", "10:00:01", "10:00:01", "skipped"),
        ],
      },
      2,
    );

    expect(summary.wallSeconds).toBe(90);
    expect(summary.byDuration.map((job) => [job.name, job.durationSeconds])).toEqual([
      ["slow", 60],
      ["queued", 10],
    ]);
    expect(summary.byStartDelay.map((job) => [job.name, job.startDelaySeconds])).toEqual([
      ["queued", 50],
      ["slow", 20],
    ]);
  });

  it.each([
    {
      values: [20, ...Array.from({ length: 19 }, (_, index) => index + 1)],
      ranks: [10, 18, 19, 20],
    },
    { values: [0], ranks: [0, 0, 0, 0] },
    { values: [], ranks: [null, null, null, null] },
  ])("summarizes unsorted timing samples without changing inputs: $values", ({ values, ranks }) => {
    const jobs = values.map((seconds) => ({
      ...timingJob("checks", "10:00:00", "10:00:00"),
      completedAt: new Date(Date.parse(timestamp("10:00:00")) + seconds * 1000).toISOString(),
    }));
    const runs = [{ ...completedRun, runAttempt: 1, jobs: [...jobs, { name: "no timestamps" }] }];
    const before = structuredClone(runs);
    const report = summarizeTrendTimings(runs, {
      generatedAtMs: Date.parse(timestamp("11:00:00")),
      compareDurationMs: 60 * 60 * 1000,
      trendDurationMs: 24 * 60 * 60 * 1000,
    });
    expect(report.cohorts.baseline.jobMetrics.executionSeconds).toEqual({
      count: values.length,
      p50: ranks[0],
      p90: ranks[1],
      p95: ranks[2],
      max: ranks[3],
    });
    expect(report.cohorts.prior.jobMetrics.executionSeconds).toEqual({
      count: 0,
      p50: null,
      p90: null,
      p95: null,
      max: null,
    });
    expect(runs).toEqual(before);
  });

  it("rejects empty CI job payloads instead of printing empty timing evidence", () => {
    expect(() => summarizeRunTimings({ ...completedRun, jobs: [] })).toThrow(
      "CI run timing summary requires at least one job",
    );
  });

  it.each([
    [
      "exact SHA",
      [run(3, "issue_comment", "current"), run(2, "push", "older"), run(1, "push", "current")],
      run(1, "push", "current"),
    ],
    [
      "newest push fallback",
      [run(4, "issue_comment", "current"), run(3, "push", "previous")],
      run(3, "push", "previous"),
    ],
  ])("selects the %s CI run", (_mode, runs, expected) => {
    expect(selectLatestMainPushCiRun(runs, "current")).toEqual(expected);
  });

  it("normalizes paginated GitHub Actions job payloads", () => {
    const defaults = {
      createdAt: null,
      labels: [],
      runnerGroupName: null,
      runnerName: null,
    };
    const restJob = {
      id: 101,
      name: "preflight",
      conclusion: "success",
      status: "completed",
      started_at: timestamp("13:25:16"),
      completed_at: timestamp("13:26:16"),
    };
    const graphqlJob = {
      databaseId: 102,
      ...timingJob("ci-timings-summary", "13:27:00", "13:28:00", "failure"),
    };
    expect(collectRunJobsFromPages([{ jobs: [restJob] }, { jobs: [graphqlJob] }])).toEqual([
      {
        ...defaults,
        databaseId: 101,
        ...timingJob("preflight", "13:25:16", "13:26:16"),
      },
      { ...defaults, ...graphqlJob },
    ]);
  });

  it("retries transient GitHub API failures while preserving auth failures", () => {
    for (const message of [
      "gh: API secondary rate limit exceeded (HTTP 403)",
      "gh: HTTP 429: too many requests",
      "Command failed: gh api repos/openclaw/openclaw/actions/runs/1/jobs\nHTTP 502",
      "read ECONNRESET",
    ]) {
      expect(isRetryableGhJsonErrorMessage(message)).toBe(true);
    }

    expect(
      isRetryableGhJsonErrorMessage("gh: Resource not accessible by integration (HTTP 403)"),
    ).toBe(false);
  });

  it.each([
    ["--latest-main -- --limit 3", { limit: 3, useLatestMain: true }],
    [
      "--trend-hours=72 --compare-hours 12 --detail-runs=80 --json --output ci-trend.json",
      { detailRuns: 80, json: true, outputPath: "ci-trend.json", trendHours: 72 },
    ],
  ])("parses monitor options: %s", (args, expected) => {
    expect(parseRunTimingArgs(args.split(" "))).toEqual({ ...timingDefaults, ...expected });
  });

  it.each([
    ["--limit 3jobs", "must be a positive integer"],
    ["--limit=0", "must be a positive integer"],
    ["--limit", "requires a value"],
    ["--output=", "requires a value"],
    ["--run-id 123456", "Unknown CI run timing option: --run-id"],
    ["123456 789012", "Unexpected CI run id argument: 789012"],
    ["--recent 3 --latest-main", "--recent cannot be combined"],
    ["123456 --latest-main", "A run id cannot be combined"],
    ["--trend-hours 72 --recent 3", "--trend-hours cannot be combined"],
    ["--trend-hours 23", "must cover at least two"],
    ["--json", "require --trend-hours"],
  ])("rejects monitor arguments: %s", (args, message) => {
    expect(() => parseRunTimingArgs(args.split(" "))).toThrow(message);
  });

  const job = {
    id: 1,
    name: "checks",
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-31T00:00:10Z",
    completed_at: "2026-08-31T00:00:40Z",
  };
  it.each<{
    label: string;
    pages: unknown[];
    requests: number;
    jobs: number;
    error?: string;
  }>([
    {
      label: "total reached",
      pages: [
        { total_count: 2, jobs: [job] },
        { total_count: 2, jobs: [job] },
      ],
      requests: 2,
      jobs: 2,
    },
    {
      label: "short pages before total",
      pages: Array.from({ length: 3 }, () => ({ total_count: 3, jobs: [job] })),
      requests: 3,
      jobs: 3,
    },
    {
      label: "missing and nonnumeric later total",
      pages: [
        { total_count: 3, jobs: [job] },
        { jobs: [job] },
        { total_count: "unknown", jobs: [job] },
      ],
      requests: 3,
      jobs: 3,
    },
    {
      label: "missing totals until empty page",
      pages: [{ jobs: [job] }, { jobs: [job] }, { jobs: [] }],
      requests: 3,
      jobs: 2,
    },
    ...[[], {}].map((empty) => ({
      label: `terminal jobs ${JSON.stringify(empty)}`,
      pages: [
        { total_count: 3, jobs: [job] },
        { total_count: 3, jobs: empty },
      ],
      requests: 2,
      jobs: 1,
    })),
    ...[[], {}].map((empty) => ({
      label: `initial jobs ${JSON.stringify(empty)}`,
      pages: [{ jobs: empty }],
      requests: 1,
      jobs: 0,
      error: "CI run timing summary requires at least one job",
    })),
    {
      label: "25-page bound",
      pages: Array.from({ length: 25 }, () => ({ total_count: 26, jobs: [job] })),
      requests: 25,
      jobs: 25,
    },
    { label: "invalid JSON", pages: ["{"], requests: 1, jobs: 0, error: "JSON" },
  ])("keeps recent filtering and normalizes each job once: $label", (fixture) => {
    const recent = fixture.label === "total reached" ? 2 : 1;
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "openclaw-ci-timings-recent-"));
    const fakeGhPath = path.join(fixtureDir, "gh");
    const callsPath = path.join(fixtureDir, "calls.jsonl");
    writeFileSync(
      fakeGhPath,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS_PATH, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args[1] === "list") {
  console.log(JSON.stringify([
    { databaseId: 201, event: "workflow_dispatch", headSha: "manual", status: "completed", conclusion: "success" },
    { databaseId: 202, event: "push", headSha: "failed", status: "completed", conclusion: "failure" },
    { databaseId: 203, event: "push", headSha: "running", status: "in_progress", conclusion: "" },
    { databaseId: 204, event: "push", headSha: "first", status: "completed", conclusion: "success", createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:01:00Z", attempt: 3 },
    { databaseId: 205, event: "push", headSha: "second", status: "completed", conclusion: "success", createdAt: "2026-08-30T23:59:00Z", updatedAt: "2026-08-31T00:01:00Z", attempt: 2 }
  ]));
} else if (args[0] === "run" && args[1] === "view") {
  console.error("run metadata must come from the captured list observation");
  process.exit(18);
} else if (args[0] === "api" && args.some((arg) => arg.includes("/jobs?"))) {
  const endpoint = args.find(arg => arg.includes("/jobs?"));
  const page = Number(new URL(endpoint, "https://api.github.com").searchParams.get("page"));
  const payload = ${JSON.stringify(fixture.pages)}[page - 1];
  if (payload === undefined) process.exit(19);
  console.log(typeof payload === "string" ? payload : JSON.stringify(payload));
} else {
  process.exit(2);
}
`,
    );
    chmodSync(fakeGhPath, 0o755);
    try {
      // Count reads on decoded API objects, then let the actual CLI consume its
      // ordinary normalized objects. Cumulative normalization revisits the getters.
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        const parse = JSON.parse;
        let normalized = 0;
        JSON.parse = (...args) => {
          const payload = parse(...args);
          if (Array.isArray(payload?.jobs)) {
            for (const item of payload.jobs) {
              const name = item.name;
              Object.defineProperty(item, "name", { get() { normalized++; return name; } });
            }
          }
          return payload;
        };
        process.on("exit", () => console.error("normalized-jobs=" + normalized));
        process.argv = [process.execPath, "scripts/ci-run-timings.mjs", "--recent", "${recent}"];
        await import("./scripts/ci-run-timings.mjs");
      `,
        ],
        {
          cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GH_TOKEN: "fixture-token",
            OPENCLAW_GH_BIN: fakeGhPath,
            FIXTURE_CALLS_PATH: callsPath,
          },
        },
      );
      const runIds = fixture.error || recent === 1 ? [204] : [204, 205];
      if (fixture.error) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(fixture.error);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.match(/CI run \d+/gu)).toEqual(runIds.map((id) => `CI run ${id}`));
        for (const id of runIds) {
          expect(result.stdout).toContain(
            id === 204
              ? "CI run 204  first  wall=60s  exec=30s  firstStartDelay=10s"
              : "CI run 205  second  wall=120s  exec=30s  firstStartDelay=70s",
          );
        }
        expect(
          result.stdout.match(
            new RegExp(`jobs=${fixture.jobs} {2}avg=30s {2}p90=30s {2}p95=30s {2}max=30s`, "gu"),
          ),
        ).toHaveLength(runIds.length);
      }
      expect(result.stderr.split(/\r?\n/u)).toContain(
        `normalized-jobs=${fixture.jobs * runIds.length}`,
      );
      const calls: string[][] = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls[0]?.slice(calls[0].indexOf("--event"), calls[0].indexOf("--event") + 2)).toEqual(
        ["--event", "push"],
      );
      expect(
        calls.filter((args) => args[0] === "run" && args[1] === "view").map((args) => args[2]),
      ).toEqual([]);
      expect(calls[0]?.[calls[0].indexOf("--json") + 1]?.split(",")).toEqual(
        expect.arrayContaining(["createdAt", "updatedAt", "attempt"]),
      );
      expect(calls.filter((args) => args[0] === "api").map((args) => args[3])).toEqual(
        runIds.flatMap((id) =>
          Array.from(
            { length: fixture.requests },
            (_, page) =>
              `repos/openclaw/openclaw/actions/runs/${id}/attempts/${id === 204 ? 3 : 2}/jobs?per_page=100&page=${page + 1}`,
          ),
        ),
      );
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });
});
