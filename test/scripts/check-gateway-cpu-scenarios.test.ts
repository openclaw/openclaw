import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { testing } from "../../scripts/check-gateway-cpu-scenarios.mts";

const tempRoots: string[] = [];
const qaFlags = ["--skip-startup", "--qa-scenario", "channel-chat-baseline"];

function makeTempRoot(): string {
  const artifactRoot = path.join(process.cwd(), ".artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(path.join(artifactRoot, "gateway-cpu-test-"));
  tempRoots.push(root);
  return root;
}

type RunParams = NonNullable<Parameters<typeof testing.runGatewayCpuScenarios>[1]>;
async function runScenario(
  flags: string[],
  fixture: Omit<RunParams, "spawnSync"> & {
    reports?: { startup?: unknown; concurrency?: unknown; qa?: unknown };
    spawnResult?: ReturnType<NonNullable<RunParams["spawnSync"]>>;
  },
  outputDir = makeTempRoot(),
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
        for (const [key, entry, file] of [
          ["startup", "scripts/bench-gateway-startup.ts", "gateway-startup-bench.json"],
          ["concurrency", "scripts/bench-gateway-concurrency.ts", "gateway-concurrency-bench.json"],
          ["qa", "openclaw qa", "qa-suite/qa-suite-summary.json"],
        ] as const) {
          if (key in reports && entry.split(" ").every((arg) => args.includes(arg))) {
            const target = path.join(outputDir, file);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, `${JSON.stringify(reports[key])}\n`);
          }
        }
        return spawnResult;
      },
    },
  );
  return { ...result, calls, outputDir };
}

function qaSummary(failed = 0) {
  return {
    counts: { failed, passed: 1 - failed, total: 1 },
    metrics: { gatewayCpuCoreRatio: 0, wallMs: 1 },
    run: { status: "completed" },
    scenarios: [{ status: failed > 0 ? "fail" : "pass", ...(failed > 0 ? {} : { steps: [{}] }) }],
  };
}

const concurrencyReport = {
  mode: "mock-streaming-agent",
  runs: [{}],
  summary: {
    eventLoopDelayP99Ms: { max: 20 },
    sessionsListLatencyMs: { p99: 30 },
    controlUiLatencyMs: { p99: 25 },
  },
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects runs with every scenario family skipped", () => {
  expect(() => testing.parseArgs(["--skip-startup", "--skip-qa"])).toThrow(
    "--skip-startup and --skip-qa cannot be used together",
  );
});

it("accepts package-manager argument separators before script options", () => {
  expect(
    testing.parseArgs(["--", "--startup-case", "default", ...qaFlags.slice(1), "--runs", "2"]),
  ).toMatchObject({
    qaScenarios: ["channel-chat-baseline"],
    runs: 2,
    startupCases: ["default"],
  });
});

it.each([
  ["--runs", "1e3", "a positive integer"],
  ["--warmup", "0x10", "a non-negative integer"],
  ["--cpu-core-warn", "1e3", "a positive number"],
])("rejects non-decimal %s", (flag, value, requirement) => {
  expect(() => testing.parseArgs([flag, value])).toThrow(`${flag} must be ${requirement}`);
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
  expect(() => testing.parseArgs(["--output-dir", "first", "--output-dir", "second"])).toThrow(
    "--output-dir was provided more than once",
  );

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/check-gateway-cpu-scenarios.mts", "--runs", "1", "--runs", "2"],
    { cwd: path.resolve("."), encoding: "utf8" },
  );

  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr.trim()).toBe("--runs was provided more than once");
  expect(result.stderr).not.toContain("Node.js");
  expect(result.stderr).not.toContain("\n    at ");
});

it("prepares CLI startup artifacts before running the startup bench", async () => {
  const result = await runScenario(["--skip-qa"], {
    env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "install" },
    reports: {
      startup: { results: [{ id: "default" }] },
      concurrency: concurrencyReport,
    },
  });
  expect(result.exitCode).toBe(0);
  expect(
    result.calls.map(({ args, env }) => [
      args[0],
      args[2],
      env?.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN,
    ]),
  ).toEqual(
    [
      "ensure-cli-startup-build.mts",
      "bench-gateway-startup.ts",
      "bench-gateway-concurrency.ts",
    ].map((script) => ["--import", `scripts/${script}`, "false"]),
  );
});

it("fails successful startup benches that write malformed reports", async () => {
  const result = await runScenario(["--skip-qa"], { reports: { startup: { results: [] } } });

  expect(result).toMatchObject({
    exitCode: 1,
    summary: {
      startupOutput: path.join(result.outputDir, "gateway-startup-bench.json"),
      startupReportFailure: "startup-report-invalid",
      startupReportFailureDetail: "startup report has no measured results",
    },
  });
});

it("fails startup build spawn errors and skips the startup bench", async () => {
  const result = await runScenario(["--skip-qa"], {
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
  for (const name of ["qa-lab", "qa-runtime"]) {
    writeFileSync(path.join(pluginSdkDist, `${name}.js`), "export {};\n");
  }
  const result = await runScenario(
    qaFlags,
    {
      cwd,
      env: {
        HOME: "/real/user/home",
        OPENCLAW_CONFIG_PATH: "/real/user/.openclaw/openclaw.json",
        OPENCLAW_HOME: "/real/user/home",
        OPENCLAW_STATE_DIR: "/real/user/.openclaw",
      },
      reports: { qa: qaSummary() },
    },
    outputDir,
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
  const result = await runScenario(qaFlags, { reports: { qa: qaSummary(1) } });

  expect(result.exitCode).toBe(1);
  expect(result.summary).toMatchObject({
    qaSummaryFailure: "qa-summary-failed-scenarios",
    qaSummaryFailureDetail: "QA suite reported 1 failed scenario(s)",
  });
});

it("fails when completed runs report hot gateway CPU observations", async () => {
  const result = await runScenario(
    ["--skip-qa", "--cpu-core-warn", "0.9", "--hot-wall-warn-ms", "30000"],
    {
      reports: {
        startup: {
          results: [
            {
              id: "default",
              summary: { cpuCoreRatio: { max: 1.15 }, readyzMs: { max: 45_000 } },
            },
          ],
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
