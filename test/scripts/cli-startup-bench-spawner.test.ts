import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATHS = [
  "scripts/test-cli-startup-bench-budget.mts",
  "scripts/test-update-cli-startup-bench.mts",
];

beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITHUB_STEP_SUMMARY", "");
});
afterEach(() => vi.unstubAllEnvs());

const stats = (value: number) => ({ avg: value, p50: value, p95: value, min: value, max: value });
const writeReport = (file: string, cases: unknown[]) =>
  fs.writeFileSync(file, JSON.stringify({ primary: { cases } }));
const measuredCase = (id: string, name: string, maxRssMb: number | null = 10) => ({
  id,
  name,
  samples: [{ ms: 10, firstOutputMs: 5, maxRssMb, exitCode: 0, signal: null }],
  summary: {
    durationMs: stats(10),
    firstOutputMs: stats(5),
    maxRssMb: maxRssMb === null ? null : stats(maxRssMb),
  },
});

function runBudget(args: string[], env = process.env, nodeArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [...nodeArgs, "--import", "tsx", "scripts/test-cli-startup-bench-budget.mts", ...args],
    { cwd: process.cwd(), encoding: "utf8", env },
  );
}

function runBenchmark(entry: string, args: string[], env = process.env) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/bench-cli-startup.ts", "--entry", entry, ...args],
    { cwd: process.cwd(), encoding: "utf8", env },
  );
}

function expectInputError(result: ReturnType<typeof runBudget>, message: string) {
  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("at ");
}

describe("CLI startup benchmark script spawners", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function budgetFixture() {
    const tmpDir = tempDirs.make("openclaw-bench-budget-");
    const baselinePath = path.join(tmpDir, "baseline.json");
    const reportPath = path.join(tmpDir, "current.json");
    return {
      tmpDir,
      baselinePath,
      reportPath,
      writeReports: (baseline: unknown[], current = baseline) => {
        writeReport(baselinePath, baseline);
        writeReport(reportPath, current);
      },
      checkBudget: (args: string[] = [], env = process.env, nodeArgs: string[] = []) =>
        runBudget(["--baseline", baselinePath, "--report", reportPath, ...args], env, nodeArgs),
    };
  }

  it("generates legacy reports by default that pass and fail enforced legacy RSS budgets", () => {
    const { tmpDir, baselinePath, reportPath, checkBudget } = budgetFixture();
    const entryPath = path.join(tmpDir, "entry.mjs");

    fs.writeFileSync(
      entryPath,
      [
        'if (process.env.OPENCLAW_BENCH_MEMORY) throw new Error("unexpected runtime RSS sidecar");',
        "const usage = process.resourceUsage();",
        "process.resourceUsage = () => ({ ...usage, maxRSS: Number(process.env.FIXTURE_RSS_MB) * 1024 });",
        'console.log("ready");',
      ].join("\n"),
    );
    writeReport(baselinePath, [
      {
        id: "health",
        name: "health",
        samples: [{ exitCode: 0, signal: null, maxRssMb: 10 }],
        summary: { durationMs: { avg: 60_000 }, maxRssMb: { avg: 10 } },
      },
    ]);
    for (const rss of [10, 13]) {
      const generated = runBenchmark(
        entryPath,
        ["--case", "health", "--runs", "1", "--warmup", "0", "--output", reportPath],
        { ...process.env, FIXTURE_RSS_MB: String(rss) },
      );
      expect(generated.status, generated.stderr).toBe(0);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      expect(report.primary).not.toHaveProperty("memoryMetric");
      expect(report.primary.cases[0].samples[0]).not.toHaveProperty("memory");
      expect(report.primary.cases[0].samples[0].maxRssMb).toBe(rss);
      const checked = checkBudget(["--preset", "startup"], {
        ...process.env,
        OPENCLAW_STARTUP_BENCH_ENFORCE_NONCANONICAL_ARCH: "1",
        OPENCLAW_STARTUP_BENCH_MAX_RSS_REGRESSION_PCT: "20",
      });
      expect(checked.status, checked.stderr).toBe(rss === 10 ? 0 : 1);
      if (rss === 13) {
        expect(checked.stderr).toContain("avg RSS 13.0MiB exceeded 12.0MiB");
      }
    }
  });

  it("rejects incompatible reused RSS metrics and still enforces compatible RSS budgets", () => {
    const { baselinePath, reportPath, checkBudget } = budgetFixture();

    const makeReport = (rss: number, memoryMetric?: string, executionMode?: unknown) => ({
      primary: {
        memoryMetric,
        executionMode,
        cases: [
          {
            id: "version",
            name: "--version",
            samples: [{ exitCode: 0, signal: null, maxRssMb: rss }],
            summary: { durationMs: { avg: 10 }, maxRssMb: { avg: rss } },
          },
        ],
      },
    });
    const run = (skipBaseline = false, actions = false) =>
      checkBudget(["--preset", "startup", ...(skipBaseline ? ["--skip-baseline"] : [])], {
        ...process.env,
        GITHUB_ACTIONS: actions ? "true" : "",
        OPENCLAW_STARTUP_BENCH_ENFORCE_NONCANONICAL_ARCH: "1",
        OPENCLAW_STARTUP_BENCH_MAX_RSS_REGRESSION_PCT: "20",
      });
    fs.writeFileSync(baselinePath, JSON.stringify(makeReport(10)));
    fs.writeFileSync(reportPath, JSON.stringify(makeReport(10, "cli-runtime-max-rss-v1")));
    const incompatible = run();
    expect(incompatible.status).toBe(1);
    expect(incompatible.stderr).toContain("Incompatible CLI RSS metrics");

    fs.writeFileSync(baselinePath, JSON.stringify(makeReport(10, "cli-runtime-max-rss-v1")));
    expect(run().status).toBe(0);
    fs.writeFileSync(reportPath, JSON.stringify(makeReport(13, "cli-runtime-max-rss-v1")));
    const regression = run();
    expect(regression.status).toBe(1);
    expect(regression.stderr).toContain("avg RSS 13.0MiB exceeded 12.0MiB");
    const advisory = run(false, true);
    expect(advisory.status, advisory.stderr).toBe(0);
    expect(advisory.stderr).toContain("::warning file=");
    expect(advisory.stderr).toContain("avg RSS 13.0MiB exceeded 12.0MiB");

    fs.writeFileSync(reportPath, JSON.stringify(makeReport(10, "unknown-metric")));
    expect(run().stderr).toContain("Unknown CLI RSS metric");
    expect(run(false, true).status).toBe(1);

    for (const [before, after, error] of [
      [undefined, "native", null],
      ["native", undefined, null],
      ["native", "native", null],
      ["transport", "transport", null],
      [undefined, "transport", "Incompatible CLI execution modes"],
      ["transport", "native", "Incompatible CLI execution modes"],
      ["unknown", "unknown", "Unknown CLI execution mode"],
      [null, "native", "Unknown CLI execution mode"],
      ["native", 1, "Unknown CLI execution mode"],
    ] satisfies Array<[unknown, unknown, string | null]>) {
      fs.writeFileSync(baselinePath, JSON.stringify(makeReport(10, undefined, before)));
      fs.writeFileSync(reportPath, JSON.stringify(makeReport(10, undefined, after)));
      const result = run();
      expect(result.status, result.stderr).toBe(error ? 1 : 0);
      if (error) {
        expect(result.stderr).toContain(error);
      }
    }
    for (const mode of [null, "unknown", 1]) {
      fs.writeFileSync(reportPath, JSON.stringify(makeReport(10, undefined, mode)));
      const result = run(true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown CLI execution mode");
    }
    fs.writeFileSync(reportPath, JSON.stringify(makeReport(10, undefined, "transport")));
    expect(run(true).status).toBe(0);
  });

  it("use the active Node executable for benchmark child processes", () => {
    for (const scriptPath of SCRIPT_PATHS) {
      const source = fs.readFileSync(path.resolve(process.cwd(), scriptPath), "utf8");

      expect(source).toContain("spawnSync(process.execPath, args");
      expect(source).not.toContain('spawnSync("node", args');
    }
  });

  it("builds the source CLI before generating a startup budget report", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/test-cli-startup-bench-budget.mts"),
      "utf8",
    );

    expect(source).toMatch(
      /spawnSync\(\s*process\.execPath,\s*\[\s*"--import",\s*"tsx",\s*"scripts\/ensure-cli-startup-build\.mts"\s*\]/u,
    );
    expect(source.indexOf("scripts/ensure-cli-startup-build.mts")).toBeLessThan(
      source.indexOf("scripts/bench-cli-startup.ts"),
    );
  });

  it("reuses warm state for gateway health while isolating fresh-state samples", () => {
    const tmpDir = tempDirs.make("openclaw-bench-state-scope-test-");
    const fixturePath = path.join(tmpDir, "record-home.mjs");
    const homeLogPath = path.join(tmpDir, "homes.log");
    fs.writeFileSync(
      fixturePath,
      [
        'import { appendFileSync } from "node:fs";',
        "appendFileSync(process.env.OPENCLAW_BENCH_HOME_LOG, `${process.env.HOME}\\n`);",
        "console.log('{\"ok\":true}');",
        "",
      ].join("\n"),
    );
    const caseIds = [
      "gatewayHealthJsonWarmState",
      "gatewayHealthJson",
      "gatewayHealthJsonFreshState",
    ];
    const reportPath = path.join(tmpDir, "state-scopes.json");
    const generated = runBenchmark(
      fixturePath,
      [
        ...caseIds.flatMap((caseId) => ["--case", caseId]),
        "--runs",
        "2",
        "--warmup",
        "1",
        "--output",
        reportPath,
      ],
      { ...process.env, OPENCLAW_BENCH_HOME_LOG: homeLogPath },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const homes = fs.readFileSync(homeLogPath, "utf8").trim().split("\n");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.primary.cases.map((commandCase: { id: string }) => commandCase.id)).toEqual(
      caseIds,
    );
    expect(homes).toHaveLength(9);
    expect(new Set(homes).size).toBe(7);
    expect(homes.every((home) => !fs.existsSync(home))).toBe(true);
    const warmedHomes = homes.slice(0, 3);
    expect(new Set(warmedHomes).size).toBe(1);
    for (const commandCase of report.primary.cases) {
      expect(commandCase.warmupSamples).toHaveLength(1);
      expect(commandCase.samples).toHaveLength(2);
      for (const sample of [...commandCase.warmupSamples, ...commandCase.samples]) {
        expect(new Date(sample.startedAt).toISOString()).toBe(sample.startedAt);
        expect(new Date(sample.endedAt).toISOString()).toBe(sample.endedAt);
        expect(Date.parse(sample.endedAt)).toBeGreaterThanOrEqual(Date.parse(sample.startedAt));
      }
    }
    for (const start of [3, 6]) {
      const sampleHomes = homes.slice(start, start + 3);
      expect(new Set(sampleHomes).size).toBe(3);
    }
  });

  it("requires authenticated gateway health probes to exit successfully", () => {
    const tmpDir = tempDirs.make("openclaw-bench-connected-test-");
    const fixturePath = path.join(tmpDir, "transport-error.mjs");
    fs.writeFileSync(
      fixturePath,
      [
        'console.log(\'{"ok":false,"gateway_transport_error":"closed"}\');',
        "process.exitCode = 1;",
        "",
      ].join("\n"),
    );
    const runCase = (caseId: string) =>
      runBenchmark(fixturePath, ["--case", caseId, "--runs", "1", "--warmup", "0"]);
    expect(runCase("gatewayHealthJson").status).toBe(0);
    for (const caseId of ["gatewayHealthJsonWarmState", "gatewayHealthJsonFreshState"]) {
      const result = runCase(caseId);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${caseId} sample 1: exited with code 1`);
    }
  });

  it("does not require unrelated fixture cases for a narrowed preset", () => {
    const { writeReports, checkBudget } = budgetFixture();

    const makeCase = (id: string, name: string) => ({
      ...measuredCase(id, name),
      contract: null,
      summary: {
        durationMs: stats(10),
        firstOutputMs: null,
        maxRssMb: null,
      },
    });
    writeReports(
      [makeCase("version", "--version"), makeCase("realOnly", "real only")],
      [makeCase("version", "--version")],
    );
    expect(checkBudget(["--preset", "startup"]).status).toBe(0);
    expect(
      checkBudget(["--preset", "all"], {
        ...process.env,
        OPENCLAW_STARTUP_BENCH_ENFORCE_NONCANONICAL_ARCH: "1",
      }).status,
    ).not.toBe(0);
  });

  it("rejects narrowed preset reports with no matching current cases", () => {
    const { writeReports, checkBudget } = budgetFixture();
    writeReports([measuredCase("gatewayStatusJson", "gateway status --json")], []);
    const result = checkBudget(["--preset", "real"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "[test-cli-startup-bench-budget] current report has no cases for preset real",
    );
  });

  it("rejects narrowed preset reports with unrelated current cases when baseline checks run", () => {
    const { writeReports, checkBudget } = budgetFixture();
    writeReports(
      [measuredCase("fixtureOnly", "fixture only")],
      [measuredCase("targetOnly", "target only")],
    );
    const result = checkBudget(["--preset", "real"], {
      ...process.env,
      OPENCLAW_STARTUP_BENCH_ENFORCE_NONCANONICAL_ARCH: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "[test-cli-startup-bench-budget] no current cases matched the baseline for preset real",
    );
  });

  it("skips x64 startup budgets on noncanonical architectures", () => {
    const { tmpDir, baselinePath, reportPath, checkBudget } = budgetFixture();
    const archShimPath = path.join(tmpDir, "arch-shim.mjs");

    const slowCase = {
      ...measuredCase("slow", "slow"),
      contract: {
        firstOutputBudgetMs: 20,
        exitBudgetMs: 20,
      },
      samples: [{ ms: 10, firstOutputMs: 10, maxRssMb: 100, exitCode: 0, signal: null }],
      summary: {
        durationMs: stats(10),
        firstOutputMs: stats(10),
        maxRssMb: stats(100),
      },
    };
    fs.writeFileSync(archShimPath, 'Object.defineProperty(process, "arch", { value: "arm64" });\n');
    writeReport(baselinePath, [
      { ...slowCase, summary: { ...slowCase.summary, durationMs: stats(1) } },
    ]);
    writeReport(reportPath, [slowCase]);
    const result = checkBudget(["--preset", "all"], undefined, ["--import", archShimPath]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("skipping x64 startup fixture budgets on arm64");
    expect(result.stderr).not.toContain("exceeded");
    const slowResponseCase = {
      ...slowCase,
      contract: {
        firstOutputBudgetMs: 1,
        exitBudgetMs: 1,
      },
    };
    writeReport(baselinePath, [slowResponseCase]);
    writeReport(reportPath, [slowResponseCase]);
    const responseBudgetResult = checkBudget(["--preset", "all"], undefined, [
      "--import",
      archShimPath,
    ]);
    expect(responseBudgetResult.status).toBe(1);
    expect(responseBudgetResult.stderr).toContain("first output 10.0ms exceeded contract 1.0ms");
    writeReport(reportPath, []);
    const missingCaseResult = checkBudget(["--preset", "all"], undefined, [
      "--import",
      archShimPath,
    ]);
    expect(missingCaseResult.status).toBe(1);
    expect(missingCaseResult.stderr).toContain("missing current case slow");
  });

  it("fails reused reports with timed-out samples", () => {
    const { writeReports, checkBudget } = budgetFixture();

    const timedOutCase = {
      ...measuredCase("version", "--version"),
      contract: { firstOutputBudgetMs: 1000, exitBudgetMs: 2000 },
      samples: [
        { ...measuredCase("version", "--version").samples[0], exitCode: null, timedOut: true },
      ],
    };
    writeReports([timedOutCase]);
    const result = checkBudget(["--skip-baseline"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[test-cli-startup-bench-budget] --version timed out.");
    expect(result.stderr).toContain(
      "[test-cli-startup-bench-budget] --version exited timeout; response contract requires a clean exit.",
    );
  });

  it("fails reused reports with missing RSS samples", () => {
    const { writeReports, checkBudget } = budgetFixture();
    writeReports([{ contract: null, ...measuredCase("version", "--version", null) }]);
    const result = checkBudget(["--skip-baseline"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "[test-cli-startup-bench-budget] --version did not report max RSS.",
    );
    expect(result.stderr).not.toContain("current report has no cases");
  });

  it("rejects malformed startup budget env vars before reading reports", () => {
    const result = runBudget([], {
      ...process.env,
      OPENCLAW_STARTUP_BENCH_MAX_RSS_REGRESSION_PCT: "20pct",
    });

    expectInputError(
      result,
      "OPENCLAW_STARTUP_BENCH_MAX_RSS_REGRESSION_PCT must be a non-negative number",
    );
  });

  it("rejects malformed startup budget CLI values before reading reports", () => {
    const malformed = runBudget(["--max-duration-regression-pct", "1e2ms"]);
    expectInputError(malformed, "--max-duration-regression-pct must be a non-negative number");

    const missing = runBudget(["--max-first-output-regression-pct"]);
    expectInputError(missing, "--max-first-output-regression-pct requires a value");
  });
});
