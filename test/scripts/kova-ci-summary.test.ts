import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/kova-ci-summary.mts", ...args], {
    encoding: "utf8",
  });
}

function runSummary(report: unknown) {
  const root = tempDirs.make("openclaw-kova-summary-");
  const reportPath = join(root, "report.json");
  const outputPath = join(root, "summary.md");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const result = runCli("--report", reportPath, "--output", outputPath);
  const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  return { output, result };
}

function metric(
  title: string,
  unit: string,
  median: number,
  overrides: Partial<{ count: unknown; max: number; p95: number }> = {},
) {
  return { count: 1, max: median, median, p95: median, title, unit, ...overrides };
}

function metricReport(status: string, metrics: Record<string, ReturnType<typeof metric>>) {
  return {
    performance: { repeat: 1, groups: [{ metrics, scenario: "gateway", state: "clean" }] },
    records: [{ scenario: "gateway", state: "clean", status }],
    summary: { statuses: { [status]: 1 } },
  };
}

const healthMetrics = {
  timeToHealthReadyMs: metric("Health ready", "ms", 20, { max: 30, p95: 30 }),
};

it("prints help without treating --help as a valued option", () => {
  const result = runCli("--help");
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain("usage: node --import tsx scripts/kova-ci-summary.mts --report");
});

it("rejects flag-shaped value before help handling", () => {
  const result = runCli("--report", "-h");
  expect(result).toMatchObject({ status: 2, stdout: "" });
  expect(result.stderr).toContain("error: --report requires a value");
});

it.each([
  ["summary.statuses", {}],
  ["records or performance groups", { summary: { statuses: { pass: 1 } } }],
  ["sampled RSS metric in performance groups", metricReport("PASS", healthMetrics)],
  [
    "sampled CPU metric in performance groups",
    metricReport("PASS", {
      resourcePeakGatewayRssMb: metric("Gateway RSS", "MB", 256),
    }),
  ],
] satisfies [string, unknown][])("rejects reports missing %s", (missing, report) => {
  const { result } = runSummary(report);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`invalid Kova report: missing ${missing}`);
});

it("rejects unknown flags instead of silently dropping report metadata", () => {
  const result = runCli("--report", "unused.json", "--report-urlz", "https://example.test/report");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("unknown argument: --report-urlz");
});

it("renders blocked reports without resource metrics", () => {
  const { output, result } = runSummary(metricReport("BLOCKED", healthMetrics));

  expect(result.status).toBe(0);
  expect(output).toContain("| gateway | clean | Health ready | 20 ms | 30 ms | 30 ms |");
  expect(output).toContain("| gateway | clean | BLOCKED |");
});

it("omits key metric rows with invalid sample counts", () => {
  const { output, result } = runSummary(
    metricReport("pass", {
      cpuPercentMax: metric("CPU max", "%", 12),
      resourcePeakGatewayRssMb: metric("Gateway RSS", "MB", 256),
      timeToHealthReadyMs: metric("Health ready", "ms", 20, { max: 30, p95: 30, count: "0" }),
    }),
  );

  expect(result.status).toBe(0);
  expect(output).not.toContain("Health ready");
  expect(output).toContain("| gateway | clean | Gateway RSS | 256 MB | 256 MB | 256 MB |");
  expect(output).toContain("| gateway | clean | CPU max | 12 % | 12 % | 12 % |");
});
