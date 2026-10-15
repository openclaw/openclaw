// Ci Run Timings tests cover ci run timings script behavior.
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
} from "../../scripts/ci-run-timings.mjs";

describe("scripts/ci-run-timings.mjs", () => {
  it("separates start delay from job duration without mislabeling dependency wait", () => {
    const summary = summarizeRunTimings(
      {
        conclusion: "success",
        createdAt: "2026-04-22T10:00:00Z",
        jobs: [
          {
            completedAt: "2026-04-22T10:01:20Z",
            conclusion: "success",
            name: "slow",
            startedAt: "2026-04-22T10:00:20Z",
            status: "completed",
          },
          {
            completedAt: "2026-04-22T10:01:00Z",
            conclusion: "success",
            name: "queued",
            startedAt: "2026-04-22T10:00:50Z",
            status: "completed",
          },
          {
            completedAt: "2026-04-22T10:00:01Z",
            conclusion: "skipped",
            name: "matrix.check_name",
            startedAt: "2026-04-22T10:00:01Z",
            status: "completed",
          },
        ],
        status: "completed",
        updatedAt: "2026-04-22T10:01:30Z",
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

  it("rejects empty CI job payloads instead of printing empty timing evidence", () => {
    expect(() =>
      summarizeRunTimings({
        conclusion: "success",
        createdAt: "2026-04-22T10:00:00Z",
        jobs: [],
        status: "completed",
        updatedAt: "2026-04-22T10:01:30Z",
      }),
    ).toThrow("CI run timing summary requires at least one job");
  });

  it("selects the push CI run for the current main SHA", () => {
    expect(
      selectLatestMainPushCiRun(
        [
          {
            databaseId: 3,
            event: "issue_comment",
            headSha: "current",
          },
          {
            databaseId: 2,
            event: "push",
            headSha: "older",
          },
          {
            databaseId: 1,
            event: "push",
            headSha: "current",
          },
        ],
        "current",
      ),
    ).toEqual({
      databaseId: 1,
      event: "push",
      headSha: "current",
    });
  });

  it("normalizes paginated GitHub Actions job payloads", () => {
    expect(
      collectRunJobsFromPages([
        {
          jobs: [
            {
              completed_at: "2026-06-01T13:26:16Z",
              conclusion: "success",
              id: 101,
              name: "preflight",
              started_at: "2026-06-01T13:25:16Z",
              status: "completed",
            },
          ],
        },
        {
          jobs: [
            {
              completedAt: "2026-06-01T13:28:00Z",
              conclusion: "failure",
              databaseId: 102,
              name: "ci-timings-summary",
              startedAt: "2026-06-01T13:27:00Z",
              status: "completed",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        completedAt: "2026-06-01T13:26:16Z",
        conclusion: "success",
        createdAt: null,
        databaseId: 101,
        labels: [],
        name: "preflight",
        runnerGroupName: null,
        runnerName: null,
        startedAt: "2026-06-01T13:25:16Z",
        status: "completed",
      },
      {
        completedAt: "2026-06-01T13:28:00Z",
        conclusion: "failure",
        createdAt: null,
        databaseId: 102,
        labels: [],
        name: "ci-timings-summary",
        runnerGroupName: null,
        runnerName: null,
        startedAt: "2026-06-01T13:27:00Z",
        status: "completed",
      },
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

  it("falls back to the newest push CI run when the exact SHA has not appeared yet", () => {
    expect(
      selectLatestMainPushCiRun(
        [
          {
            databaseId: 4,
            event: "issue_comment",
            headSha: "current",
          },
          {
            databaseId: 3,
            event: "push",
            headSha: "previous",
          },
        ],
        "current",
      ),
    ).toEqual({
      databaseId: 3,
      event: "push",
      headSha: "previous",
    });
  });

  it("ignores pnpm passthrough sentinels when parsing monitor args", () => {
    expect(parseRunTimingArgs(["--latest-main", "--", "--limit", "3"])).toEqual({
      compareHours: 12,
      detailRuns: 100,
      explicitRunId: undefined,
      json: false,
      limit: 3,
      outputPath: null,
      recentLimit: null,
      trendHours: null,
      useLatestMain: true,
    });
  });

  it("parses bounded trend comparison and JSON report options", () => {
    expect(
      parseRunTimingArgs([
        "--trend-hours=72",
        "--compare-hours",
        "12",
        "--detail-runs=80",
        "--json",
        "--output",
        "ci-trend.json",
      ]),
    ).toEqual({
      compareHours: 12,
      detailRuns: 80,
      explicitRunId: undefined,
      json: true,
      limit: 15,
      outputPath: "ci-trend.json",
      recentLimit: null,
      trendHours: 72,
      useLatestMain: false,
    });
  });

  it("rejects malformed monitor limits instead of falling back", () => {
    for (const args of [
      ["--limit", "3jobs"],
      ["--limit", "0"],
      ["--limit=1e3"],
      ["--recent", "recent"],
      ["--recent", "0"],
      ["--trend-hours", "0"],
      ["--compare-hours", "1.5"],
      ["--detail-runs", "all"],
    ]) {
      expect(() => parseRunTimingArgs(args)).toThrow("must be a positive integer");
    }
  });

  it("rejects missing monitor limits instead of treating flags as values", () => {
    for (const args of [
      ["--limit"],
      ["--limit", "--recent", "4"],
      ["--limit", "-h"],
      ["--recent"],
      ["--recent", "-h"],
      ["--trend-hours"],
      ["--compare-hours", "--json"],
      ["--detail-runs"],
      ["--output="],
    ]) {
      expect(() => parseRunTimingArgs(args)).toThrow("requires a value");
    }
  });

  it("rejects unknown monitor flags and duplicate run ids", () => {
    expect(() => parseRunTimingArgs(["--run-id", "123456"])).toThrow(
      "Unknown CI run timing option: --run-id",
    );
    expect(() => parseRunTimingArgs(["123456", "789012"])).toThrow(
      "Unexpected CI run id argument: 789012",
    );
  });

  it("rejects ambiguous monitor modes and incomplete comparison windows", () => {
    expect(() => parseRunTimingArgs(["--recent", "3", "--latest-main"])).toThrow(
      "--recent cannot be combined",
    );
    expect(() => parseRunTimingArgs(["123456", "--latest-main"])).toThrow(
      "A run id cannot be combined",
    );
    expect(() => parseRunTimingArgs(["--trend-hours", "72", "--recent", "3"])).toThrow(
      "--trend-hours cannot be combined",
    );
    expect(() => parseRunTimingArgs(["--trend-hours", "23"])).toThrow("must cover at least two");
    expect(() => parseRunTimingArgs(["--json"])).toThrow("require --trend-hours");
  });

  it("excludes manual, failed, and unfinished runs from recent main timings", () => {
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
    { databaseId: 204, event: "push", headSha: "first", status: "completed", conclusion: "success" },
    { databaseId: 205, event: "push", headSha: "second", status: "completed", conclusion: "success" }
  ]));
} else if (args[0] === "run" && args[1] === "view") {
  console.log(JSON.stringify({ status: "completed", conclusion: "success", createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:01:00Z" }));
} else if (args[0] === "api" && args.some((arg) => arg.includes("/jobs?"))) {
  console.log(JSON.stringify({ total_count: 1, jobs: [{ id: 1, name: "checks", status: "completed", conclusion: "success", started_at: "2026-08-31T00:00:10Z", completed_at: "2026-08-31T00:00:40Z" }] }));
} else {
  process.exit(2);
}
`,
    );
    chmodSync(fakeGhPath, 0o755);
    try {
      const result = spawnSync(process.execPath, ["scripts/ci-run-timings.mjs", "--recent", "2"], {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "fixture-token",
          OPENCLAW_GH_BIN: fakeGhPath,
          FIXTURE_CALLS_PATH: callsPath,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.match(/CI run \d+/gu)).toEqual(["CI run 204", "CI run 205"]);
      const calls: string[][] = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls[0]?.slice(calls[0].indexOf("--event"), calls[0].indexOf("--event") + 2)).toEqual(
        ["--event", "push"],
      );
      expect(
        calls.filter((args) => args[0] === "run" && args[1] === "view").map((args) => args[2]),
      ).toEqual(["204", "205"]);
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });
});
