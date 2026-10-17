import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { testing } from "../../scripts/check-gateway-cpu-scenarios.mts";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const artifactRoot = path.join(process.cwd(), ".artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(path.join(artifactRoot, "gateway-cpu-test-"));
  tempRoots.push(root);
  return root;
}

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/check-gateway-cpu-scenarios.mts", ...args],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
    },
  );
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

type RunParams = NonNullable<Parameters<typeof testing.runGatewayCpuScenarios>[1]>;
async function runScenario(
  outputDir: string,
  flags: string[],
  fixture: Omit<RunParams, "spawnSync"> & {
    reports?: Record<string, () => void>;
    spawnResult?: ReturnType<NonNullable<RunParams["spawnSync"]>>;
  },
) {
  const { reports = {}, spawnResult = { status: 0 }, ...params } = fixture;
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const result = await testing.runGatewayCpuScenarios(
    testing.parseArgs(["--output-dir", outputDir, ...flags]),
    {
      silent: true,
      ...params,
      spawnSync: (_command, args, options) => {
        calls.push({ args, env: options.env });
        for (const [entry, write] of Object.entries(reports)) {
          if (entry.split(" ").every((arg) => args.includes(arg))) {
            write();
          }
        }
        return spawnResult;
      },
    },
  );
  return { ...result, calls };
}

function writeReport(outputDir: string, file: string, report: unknown) {
  writeFileSync(path.join(outputDir, file), `${JSON.stringify(report)}\n`);
}

function writeQaSuiteSummary(
  outputDir: string,
  counts: { failed: number; passed: number; total: number } = { failed: 0, passed: 1, total: 1 },
): void {
  const qaOutputDir = path.join(outputDir, "qa-suite");
  mkdirSync(qaOutputDir, { recursive: true });
  writeReport(qaOutputDir, "qa-suite-summary.json", {
    counts,
    metrics: { gatewayCpuCoreRatio: 0, wallMs: 1 },
    run: { status: "completed" },
    scenarios: [
      {
        status: counts.failed > 0 ? "fail" : "pass",
        ...(counts.failed > 0 ? {} : { steps: [{}] }),
      },
    ],
  });
}

function writeConcurrencyReport(outputDir: string): void {
  writeReport(outputDir, "gateway-concurrency-bench.json", {
    mode: "mock-streaming-agent",
    runs: [{}],
    summary: {
      eventLoopDelayP99Ms: { max: 20 },
      sessionsListLatencyMs: { p99: 30 },
      controlUiLatencyMs: { p99: 25 },
    },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects runs with every scenario family skipped", () => {
  expect(() =>
    testing.parseArgs(["--output-dir", makeTempRoot(), "--skip-startup", "--skip-qa"]),
  ).toThrow("--skip-startup and --skip-qa cannot be used together");
});

it("accepts package-manager argument separators before script options", () => {
  expect(
    testing.parseArgs([
      "--",
      "--output-dir",
      makeTempRoot(),
      "--startup-case",
      "default",
      "--qa-scenario",
      "channel-chat-baseline",
      "--runs",
      "2",
    ]),
  ).toMatchObject({
    qaScenarios: ["channel-chat-baseline"],
    runs: 2,
    startupCases: ["default"],
  });
});

it("rejects non-decimal numeric options", () => {
  expect(() => testing.parseArgs(["--output-dir", makeTempRoot(), "--runs", "1e3"])).toThrow(
    "--runs must be a positive integer",
  );
  expect(() => testing.parseArgs(["--output-dir", makeTempRoot(), "--warmup", "0x10"])).toThrow(
    "--warmup must be a non-negative integer",
  );
  expect(() =>
    testing.parseArgs(["--output-dir", makeTempRoot(), "--cpu-core-warn", "1e3"]),
  ).toThrow("--cpu-core-warn must be a positive number");
});

it("rejects missing valued options instead of consuming the next flag", () => {
  for (const flag of [
    "--output-dir",
    "--startup-case",
    "--qa-scenario",
    "--runs",
    "--warmup",
    "--cpu-core-warn",
    "--hot-wall-warn-ms",
  ]) {
    for (const value of ["--skip-qa", "-h"]) {
      expect(() => testing.parseArgs([flag, value])).toThrow(`Missing value for ${flag}`);
    }
  }
});

it("rejects duplicate single-value controls before running scenarios", () => {
  expect(() =>
    testing.parseArgs(["--output-dir", makeTempRoot(), "--output-dir", makeTempRoot()]),
  ).toThrow("--output-dir was provided more than once");

  const result = runCli("--runs", "1", "--runs", "2");

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe("--runs was provided more than once");
  expectNoNodeStack(result.stderr);
});

it("prepares CLI startup artifacts before running the startup bench", async () => {
  const outputDir = makeTempRoot();
  const result = await runScenario(outputDir, ["--runs", "1", "--warmup", "0", "--skip-qa"], {
    env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "install" },
    reports: {
      "scripts/bench-gateway-startup.ts": () =>
        writeReport(outputDir, "gateway-startup-bench.json", { results: [{ id: "default" }] }),
      "scripts/bench-gateway-concurrency.ts": () => writeConcurrencyReport(outputDir),
    },
  });
  const { calls } = result;

  expect(result.exitCode).toBe(0);
  expect(calls.map((call) => call.args[0])).toEqual(["--import", "--import", "--import"]);
  expect(calls.map((call) => call.args[2])).toEqual([
    "scripts/ensure-cli-startup-build.mts",
    "scripts/bench-gateway-startup.ts",
    "scripts/bench-gateway-concurrency.ts",
  ]);
  expect(calls.map((call) => call.env?.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN)).toEqual([
    "false",
    "false",
    "false",
  ]);
});

it("fails successful startup benches that write malformed reports", async () => {
  const outputDir = makeTempRoot();
  const startupOutput = path.join(outputDir, "gateway-startup-bench.json");
  const result = await runScenario(outputDir, ["--runs", "1", "--warmup", "0", "--skip-qa"], {
    reports: {
      "scripts/bench-gateway-startup.ts": () =>
        writeReport(outputDir, "gateway-startup-bench.json", { results: [] }),
    },
  });

  expect(result.exitCode).toBe(1);
  expect(result.summary).toMatchObject({
    startupOutput,
    startupReportFailure: "startup-report-invalid",
    startupReportFailureDetail: "startup report has no measured results",
  });
});

it("fails startup build spawn errors and skips the startup bench", async () => {
  const outputDir = makeTempRoot();
  const result = await runScenario(outputDir, ["--skip-qa"], {
    spawnResult: {
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      signal: null,
      status: null,
    },
  });

  expect(result.exitCode).toBe(1);
  expect(result.calls.map((call) => call.args)).toEqual([
    ["--import", "tsx", "scripts/ensure-cli-startup-build.mts"],
  ]);
  expect(result.summary.steps).toEqual([
    { name: "startup build", error: "spawn ENOENT", signal: null, status: 1 },
    { name: "startup bench", signal: null, status: 1 },
    { name: "concurrency bench", signal: null, status: 1 },
  ]);
});

it("does not prebuild private QA dist when the required entries already exist", async () => {
  const cwd = makeTempRoot();
  const outputDir = path.join(cwd, "out");
  const pluginSdkDist = path.join(cwd, "dist", "plugin-sdk");
  mkdirSync(pluginSdkDist, { recursive: true });
  writeFileSync(path.join(pluginSdkDist, "qa-lab.js"), "export {};\n");
  writeFileSync(path.join(pluginSdkDist, "qa-runtime.js"), "export {};\n");
  const result = await runScenario(
    outputDir,
    ["--skip-startup", "--qa-scenario", "channel-chat-baseline"],
    {
      cwd,
      env: {
        HOME: "/real/user/home",
        OPENCLAW_CONFIG_PATH: "/real/user/.openclaw/openclaw.json",
        OPENCLAW_HOME: "/real/user/home",
        OPENCLAW_STATE_DIR: "/real/user/.openclaw",
      },
      reports: { "openclaw qa": () => writeQaSuiteSummary(outputDir) },
    },
  );
  const { calls } = result;

  expect(result.exitCode).toBe(0);
  expect(result.summary.steps.map((step) => step.name)).toEqual([
    "node worker finalization gate",
    "qa suite",
  ]);
  expect(calls.some((call) => call.args[0] === "scripts/build-all.mts")).toBe(false);
  expect(calls[0]?.env).toMatchObject({
    HOME: path.join(outputDir, "qa-state-root", "home"),
    OPENCLAW_CONFIG_PATH: path.join(outputDir, "qa-state-root", "state", "openclaw.json"),
    OPENCLAW_HOME: path.join(outputDir, "qa-state-root", "home"),
    OPENCLAW_STATE_DIR: path.join(outputDir, "qa-state-root", "state"),
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    USERPROFILE: path.join(outputDir, "qa-state-root", "home"),
  });
  expect(calls[0]?.env?.HOME).not.toBe("/real/user/home");
});

it("fails successful QA commands that report failed scenarios", async () => {
  const outputDir = makeTempRoot();
  const result = await runScenario(
    outputDir,
    ["--skip-startup", "--qa-scenario", "channel-chat-baseline"],
    {
      reports: {
        "openclaw qa": () => writeQaSuiteSummary(outputDir, { failed: 1, passed: 0, total: 1 }),
      },
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.summary).toMatchObject({
    qaSummaryFailure: "qa-summary-failed-scenarios",
    qaSummaryFailureDetail: "QA suite reported 1 failed scenario(s)",
  });
});

it("fails when completed runs report hot gateway CPU observations", async () => {
  const outputDir = makeTempRoot();
  const result = await runScenario(
    outputDir,
    ["--skip-qa", "--cpu-core-warn", "0.9", "--hot-wall-warn-ms", "30000"],
    {
      reports: {
        "scripts/bench-gateway-startup.ts": () => {
          writeReport(outputDir, "gateway-startup-bench.json", {
            results: [
              {
                id: "default",
                summary: { cpuCoreRatio: { max: 1.15 }, readyzMs: { max: 45_000 } },
              },
            ],
          });
        },
      },
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.summary.observations).toEqual([
    {
      kind: "startup-cpu-hot",
      id: "default",
      cpuCoreRatioMax: 1.15,
      wallMsMax: 45_000,
    },
  ]);
});
