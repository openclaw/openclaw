import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { testing } from "../../scripts/test-perf-budget.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function checkReport(
  payload: unknown,
  expected: string | { fileCount: number; totalFileDurationMs: number },
) {
  const reportPath = path.join(tempDirs.make("perf-report-"), "report.json");
  fs.writeFileSync(
    reportPath,
    typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`,
  );
  if (typeof expected === "string") {
    expect(() => testing.collectPerfReportStats(reportPath)).toThrow(expected);
  } else {
    expect(testing.collectPerfReportStats(reportPath)).toEqual(expected);
  }
}

it.each([
  { actions: "", childExitCode: 0, expectedExitCode: 1 },
  { actions: "true", childExitCode: 0, expectedExitCode: 0 },
  { actions: "true", childExitCode: 2, expectedExitCode: 2 },
])(
  "keeps runner failures blocking and reports timing limits ($actions/$childExitCode)",
  ({ actions, childExitCode, expectedExitCode }) => {
    const root = tempDirs.make("openclaw-perf-budget-boundary-");
    const preloadPath = path.join(root, "vitest-report-fixture.mjs");
    const summaryPath = path.join(root, "summary.md");
    fs.writeFileSync(
      preloadPath,
      `
      import childProcess from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      childProcess.spawnSync = (_command, args) => {
        fs.writeFileSync(args[args.indexOf("--outputFile") + 1], JSON.stringify({
          testResults: [{ startTime: 1000, endTime: 1001 }],
        }));
        return { status: ${childExitCode} };
      };
      syncBuiltinESMExports();
    `,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preloadPath,
        ..."--import ./scripts/tsx.mjs scripts/test-perf-budget.mts --max-wall-ms 0".split(" "),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          GITHUB_ACTIONS: actions,
          GITHUB_STEP_SUMMARY: summaryPath,
          TMPDIR: root,
          TEMP: root,
          TMP: root,
        },
      },
    );
    expect(result.status, result.stderr).toBe(expectedExitCode);
    if (actions && childExitCode === 0) {
      expect(result.stderr).toContain("::warning file=");
      expect(fs.readFileSync(summaryPath, "utf8")).toContain("Test wall-time budget");
    } else {
      expect(result.stderr).not.toContain("::warning");
      expect(fs.existsSync(summaryPath)).toBe(false);
    }
  },
);

const reportOnly = { baselineWallMs: null, maxWallMs: null, reportOnly: true };
it.each([
  [["--report-only"], {}, reportOnly],
  [[], { OPENCLAW_TEST_PERF_REPORT_ONLY: "yes" }, reportOnly],
  [
    ["--baseline-wall-ms", "1000"],
    {},
    { baselineWallMs: 1000, maxRegressionPct: 10, maxWallMs: null, reportOnly: false },
  ],
  [
    [],
    {
      OPENCLAW_TEST_PERF_BASELINE_WALL_MS: "1000",
      OPENCLAW_TEST_PERF_MAX_REGRESSION_PCT: "12.5",
      OPENCLAW_TEST_PERF_MAX_WALL_MS: "1500",
    },
    { baselineWallMs: 1000, maxRegressionPct: 12.5, maxWallMs: 1500 },
  ],
  [["--max-wall-ms", "1e3"], {}, { maxWallMs: 1000 }],
] as const)("parses budget arguments %j and env %j", (args, env, expected) => {
  expect(testing.parseArgs(args, env)).toMatchObject(expected);
});

it("rejects malformed environment budgets", () => {
  expect(() =>
    testing.parseArgs([], {
      OPENCLAW_TEST_PERF_MAX_WALL_MS: "1000ms",
    }),
  ).toThrow("OPENCLAW_TEST_PERF_MAX_WALL_MS must be a non-negative number");
});

it.each([
  [[], "provide --max-wall-ms, --baseline-wall-ms, or set --report-only"],
  [["--max-wall-ms", "1e3ms"], "--max-wall-ms must be a non-negative number"],
  [["--max-regression-pct"], "--max-regression-pct requires a value"],
  [["--max-wall-ms", "--baseline-wall-ms", "1000"], "--max-wall-ms requires a value"],
  [["--max-wall-ms", "-h"], "--max-wall-ms requires a value"],
  [["--max-regression-pct", "-h"], "--max-regression-pct requires a value"],
  [["--max-wall-ms", "1000", "--max-wall-ms", "2000"], "--max-wall-ms was provided more than once"],
] as const)("rejects invalid budget arguments %j", (args, message) => {
  expect(() => testing.parseArgs(args, {})).toThrow(message);
});

it("requires timed file evidence in the Vitest JSON report", () => {
  checkReport(
    { testResults: [{ startTime: 1000, endTime: 1400 }] },
    { fileCount: 1, totalFileDurationMs: 400 },
  );
  checkReport({ testResults: [] }, "Vitest JSON report contained no timed file results");
  checkReport(
    { testResults: [{ name: "missing-timing" }] },
    "Vitest JSON report contained no timed file results",
  );
  checkReport("{", "failed to read Vitest JSON report");
});
