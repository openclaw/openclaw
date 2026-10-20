// Test Perf Budget tests cover test perf budget script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/test-perf-budget.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function withReport(payload: unknown, run: (reportPath: string) => void) {
  const reportPath = path.join(os.tmpdir(), `openclaw-test-perf-budget-${Date.now()}.json`);
  fs.writeFileSync(
    reportPath,
    typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`,
  );
  try {
    run(reportPath);
  } finally {
    fs.rmSync(reportPath, { force: true });
  }
}

describe("test perf budget script", () => {
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
          "--import",
          "./scripts/tsx.mjs",
          "scripts/test-perf-budget.mts",
          "--max-wall-ms",
          "0",
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

  it("requires a budget source unless report-only mode is explicit", () => {
    expect(() => testing.parseArgs([], {})).toThrow(
      "provide --max-wall-ms, --baseline-wall-ms, or set --report-only",
    );
    expect(testing.parseArgs(["--report-only"], {})).toMatchObject({
      baselineWallMs: null,
      maxWallMs: null,
      reportOnly: true,
    });
    expect(
      testing.parseArgs([], {
        OPENCLAW_TEST_PERF_REPORT_ONLY: "yes",
      }),
    ).toMatchObject({
      baselineWallMs: null,
      maxWallMs: null,
      reportOnly: true,
    });
    expect(testing.parseArgs(["--baseline-wall-ms", "1000"], {})).toMatchObject({
      baselineWallMs: 1000,
      maxRegressionPct: 10,
      maxWallMs: null,
      reportOnly: false,
    });
  });

  it("parses numeric budget env vars strictly before running Vitest", () => {
    expect(
      testing.parseArgs([], {
        OPENCLAW_TEST_PERF_BASELINE_WALL_MS: "1000",
        OPENCLAW_TEST_PERF_MAX_REGRESSION_PCT: "12.5",
        OPENCLAW_TEST_PERF_MAX_WALL_MS: "1500",
      }),
    ).toMatchObject({
      baselineWallMs: 1000,
      maxRegressionPct: 12.5,
      maxWallMs: 1500,
    });

    expect(() =>
      testing.parseArgs([], {
        OPENCLAW_TEST_PERF_MAX_WALL_MS: "1000ms",
      }),
    ).toThrow("OPENCLAW_TEST_PERF_MAX_WALL_MS must be a non-negative number");
  });

  it("rejects malformed CLI budget values before running Vitest", () => {
    expect(testing.parseArgs(["--max-wall-ms", "1e3"], {})).toMatchObject({
      maxWallMs: 1000,
    });

    expect(() => testing.parseArgs(["--max-wall-ms", "1e3ms"], {})).toThrow(
      "--max-wall-ms must be a non-negative number",
    );
    expect(() => testing.parseArgs(["--max-regression-pct"], {})).toThrow(
      "--max-regression-pct requires a value",
    );
    expect(() => testing.parseArgs(["--max-wall-ms", "--baseline-wall-ms", "1000"], {})).toThrow(
      "--max-wall-ms requires a value",
    );
    expect(() => testing.parseArgs(["--max-wall-ms", "-h"], {})).toThrow(
      "--max-wall-ms requires a value",
    );
    expect(() => testing.parseArgs(["--max-regression-pct", "-h"], {})).toThrow(
      "--max-regression-pct requires a value",
    );
    expect(() => testing.parseArgs(["--max-wall-ms", "1000", "--max-wall-ms", "2000"], {})).toThrow(
      "--max-wall-ms was provided more than once",
    );
  });

  it("requires timed file evidence in the Vitest JSON report", () => {
    withReport(
      {
        testResults: [{ endTime: 1400, name: "test/scripts/demo.test.ts", startTime: 1000 }],
      },
      (reportPath) => {
        expect(testing.collectPerfReportStats(reportPath)).toEqual({
          fileCount: 1,
          totalFileDurationMs: 400,
        });
      },
    );

    withReport({ testResults: [] }, (reportPath) => {
      expect(() => testing.collectPerfReportStats(reportPath)).toThrow(
        "Vitest JSON report contained no timed file results",
      );
    });
    withReport({ testResults: [{ name: "missing-timing" }] }, (reportPath) => {
      expect(() => testing.collectPerfReportStats(reportPath)).toThrow(
        "Vitest JSON report contained no timed file results",
      );
    });
    withReport("{", (reportPath) => {
      expect(() => testing.collectPerfReportStats(reportPath)).toThrow(
        "failed to read Vitest JSON report",
      );
    });
  });
});
