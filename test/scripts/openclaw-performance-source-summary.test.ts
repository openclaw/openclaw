import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMarkdown, parseArgs } from "../../scripts/openclaw-performance-source-summary.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mkTmpRoot = () => tempDirs.make("openclaw-source-summary-");

const mockHello = {
  counts: { failed: 0, passed: 1, total: 1 },
  metrics: {
    gatewayCpuCoreRatio: 0.15,
    gatewayProcessRssDeltaBytes: 1024 * 1024,
    gatewayProcessRssEndBytes: 91 * 1024 * 1024,
    gatewayProcessRssStartBytes: 90 * 1024 * 1024,
    wallMs: 250,
  },
  scenarios: [{ id: "mock-hello", status: "pass" }],
};

const sqliteRun = {
  integrity: { agent: ["ok"], state: "ok" },
  profile: "smoke",
  rows: { agentCacheEntries: 1000, stateRows: 4100 },
  timingsMs: { total: 150 },
  walBytes: { stateAfter: 0, stateBefore: 4096 },
};

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/openclaw-performance-source-summary.mts", ...args],
    { cwd: path.resolve("."), encoding: "utf8" },
  );
}

function writeSourceFixture(sourceDir = mkTmpRoot()) {
  writeJson(path.join(sourceDir, "gateway-cpu", "gateway-startup-bench.json"), {
    results: [
      {
        id: "default",
        summary: {
          readyzMs: { p50: 12 },
          maxRssMb: { p95: 120 },
          cpuCoreRatio: { p95: 0.25 },
        },
      },
    ],
  });
  writeJson(path.join(sourceDir, "gateway-cpu", "summary.json"), {
    observations: [],
  });
  writeJson(path.join(sourceDir, "cli-startup.json"), {
    primary: {
      cases: [
        {
          id: "gatewayHealthJson",
          summary: {
            durationMs: { p50: 10 },
            maxRssMb: { p95: 90 },
          },
        },
      ],
    },
  });
  writeJson(path.join(sourceDir, "extension-memory.json"), {
    baseline: { maxRssMb: 50 },
    combined: { maxRssMb: 180 },
    topByDeltaMb: [{ dir: "extensions/browser", maxRssMb: 80, deltaFromBaselineMb: 12 }],
  });
  writeJson(path.join(sourceDir, "sqlite-perf-smoke.json"), {
    ...sqliteRun,
    queries: [{ p50Ms: 0.1, p95Ms: 0.2, query: "SELECT 1", rows: 1 }],
  });
  writeJson(path.join(sourceDir, "mock-hello/run-001/qa-suite-summary.json"), mockHello);
  return sourceDir;
}

it("labels CLI RSS semantics and rejects mixed-metric memory trends", () => {
  const sourceDir = writeSourceFixture();
  const baselineDir = writeSourceFixture();
  expect(buildMarkdown(sourceDir, baselineDir)).toContain("RSS metric: legacy-last-marker");
  const cliPath = path.join(sourceDir, "cli-startup.json");
  const cli = JSON.parse(fs.readFileSync(cliPath, "utf8"));
  cli.primary.memoryMetric = "cli-runtime-max-rss-v1";
  writeJson(cliPath, cli);
  expect(() => buildMarkdown(sourceDir, baselineDir)).toThrow("Incompatible CLI RSS metrics");
  writeJson(path.join(baselineDir, "cli-startup.json"), cli);
  expect(buildMarkdown(sourceDir, baselineDir)).toContain("RSS metric: cli-runtime-max-rss-v1");
  writeJson(cliPath, { primary: { ...cli.primary, executionMode: "transport" } });
  expect(() => buildMarkdown(sourceDir, baselineDir)).toThrow("Incompatible CLI execution modes");
});

function sqliteQuery(overrides: Record<string, unknown> = {}) {
  return {
    database: "state",
    id: "delivery.pending.load",
    p50Ms: 10,
    p95Ms: 12,
    plan: {
      fullTableScans: [],
      indexes: ["idx_delivery_queue_pending"],
      raw: ["SEARCH delivery_queue_entries USING INDEX idx_delivery_queue_pending"],
      tempSorts: [],
    },
    rows: 1000,
    runs: 12,
    sql: "SELECT id FROM delivery_queue_entries WHERE queue_name = ? AND status = ?",
    ...overrides,
  };
}

function makeSqliteSource(queries: Array<Record<string, unknown>> = [sqliteQuery()]) {
  const sourceDir = writeSourceFixture();
  writeJson(path.join(sourceDir, "sqlite-perf-smoke.json"), {
    ...sqliteRun,
    queries,
    schemaVersion: 2,
    versions: { agentSchema: 16, sqlite: "3.53.4", stateSchema: 13 },
  });
  return sourceDir;
}

const scanPlan = {
  fullTableScans: ["SCAN delivery_queue_entries"],
  indexes: [],
  raw: ["SCAN delivery_queue_entries"],
  tempSorts: [],
};

describe("parseArgs", () => {
  it("parses source summary paths", () => {
    expect(
      parseArgs([
        "--source-dir",
        "reports/current",
        "--baseline-source-dir",
        "reports/baseline",
        "--output",
        "summary.md",
      ]),
    ).toEqual({
      sourceDir: path.resolve("reports/current"),
      baselineSourceDir: path.resolve("reports/baseline"),
      output: path.resolve("summary.md"),
    });
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    for (const [args, error] of [
      [[], "--source-dir is required"],
      [["--wat"], "Unknown argument: --wat"],
    ] as const) {
      const result = runCli(...args);
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(result.stderr.trim()).toBe(error);
      expect(result.stderr).not.toMatch(/Node\.js|\n {4}at /);
    }
  });
});

describe("buildMarkdown", () => {
  it("compares reordered v2 SQLite scenarios only by shared scenario ID", () => {
    const agentQuery = sqliteQuery({
      database: "agent",
      id: "agent-cache.plugin-model-catalog.list",
      p50Ms: 1,
      p95Ms: 2,
      rows: 100,
    });
    const currentQuery = sqliteQuery({ p95Ms: 15 });
    const sourceDir = makeSqliteSource([currentQuery, agentQuery]);
    const baselineDir = makeSqliteSource([
      { ...agentQuery, id: "baseline-only", p50Ms: 3, p95Ms: 4 },
      { ...currentQuery, p50Ms: 18, p95Ms: 20 },
    ]);

    const markdown = buildMarkdown(sourceDir, baselineDir);

    expect(markdown).toContain("| current | v2 | smoke | 3.53.4 | 13 | 16 |");
    expect(markdown).toContain(
      "| delivery.pending.load | state | 1000 | 12 | 10.0ms | 15.0ms | 1000 | 12 | 20.0ms | -25.0% |",
    );
    expect(markdown).toContain(
      "| agent-cache.plugin-model-catalog.list | agent | 100 | 12 | 1.0ms | 2.0ms | n/a | n/a | n/a | n/a |",
    );
    expect(markdown).not.toContain("| baseline-only |");
  });

  it("does not compare v2 SQLite scenarios with different workloads", () => {
    for (const overrides of [
      { rows: 999, runs: 20 },
      { database: "agent" },
      { sql: "SELECT id FROM delivery_queue_entries WHERE status = ?" },
    ]) {
      const sourceDir = makeSqliteSource();
      const baselineQuery = sqliteQuery({ ...overrides, p50Ms: 18, p95Ms: 20 });
      const baselineDir = makeSqliteSource([baselineQuery]);

      expect(buildMarkdown(sourceDir, baselineDir)).toContain(
        `| delivery.pending.load | state | 1000 | 12 | 10.0ms | 12.0ms | ${baselineQuery.rows} | ${baselineQuery.runs} | 20.0ms | n/a (workload differs) |`,
      );
    }
  });

  it.each<[Record<string, unknown>, string]>([
    [{ p95Ms: null }, "metrics"],
    [{ plan: { ...scanPlan, fullTableScans: [42] } }, "plan"],
    [{ plan: { ...scanPlan, fullTableScans: [], indexes: ["idx_fake"] } }, "plan"],
    [{ id: "delivery.pending\nload" }, "ID"],
  ])("rejects malformed v2 SQLite scenario $1", (overrides, error) => {
    const sourceDir = makeSqliteSource([
      sqliteQuery({ plan: scanPlan, sql: "SELECT id FROM delivery_queue_entries", ...overrides }),
    ]);
    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      `[source-performance] invalid SQLite scenario ${error}:`,
    );
  });

  it("rejects a missing source directory", () => {
    expect(() => buildMarkdown(path.join(mkTmpRoot(), "missing"), null)).toThrow(
      "[source-performance] missing required source dir:",
    );
  });

  it("rejects missing source performance artifacts", () => {
    const sourceDir = mkTmpRoot();

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] missing required gateway startup artifact:",
    );
  });

  it.each<[string, unknown, string]>([
    ["mock-hello/run-001/qa-suite-summary.json", {}, "invalid mock hello summary counts"],
    [
      "mock-hello/run-001/qa-suite-summary.json",
      { ...mockHello, scenarios: [{ id: "mock-hello", status: "fail" }] },
      "invalid mock hello scenario evidence",
    ],
    [
      "gateway-cpu/gateway-startup-bench.json",
      { results: [{ id: "default", summary: { readyzMs: { p50: 12 } } }] },
      "incomplete gateway startup metrics for default",
    ],
    [
      "extension-memory.json",
      {
        topByDeltaMb: [
          { dir: "extensions/browser", maxRssMb: 80, deltaFromBaselineMb: 12, status: "ok" },
        ],
      },
      "incomplete extension memory context",
    ],
    [
      "sqlite-perf-smoke.json",
      { ...sqliteRun, rows: { stateRows: 4100 } },
      "incomplete SQLite perf metrics",
    ],
    [
      "sqlite-perf-smoke.json",
      {
        ...sqliteRun,
        integrity: { agent: ["ok", "database disk image is malformed"], state: "ok" },
        profile: "smoke",
      },
      "SQLite agent integrity check did not pass",
    ],
  ])("rejects $2", (relative, artifact, message) => {
    const sourceDir = writeSourceFixture();
    writeJson(path.join(sourceDir, relative), artifact);
    expect(() => buildMarkdown(sourceDir, null)).toThrow(`[source-performance] ${message}:`);
  });

  it("allows source performance fixtures without older-ref SQLite smoke artifacts", () => {
    const sourceDir = writeSourceFixture();
    fs.rmSync(path.join(sourceDir, "sqlite-perf-smoke.json"));

    expect(buildMarkdown(sourceDir, null)).toMatch(/## SQLite State Smoke\s+No data\./u);
  });
});
