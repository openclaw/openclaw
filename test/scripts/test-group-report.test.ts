import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildGroupedTestComparison,
  buildGroupedTestReport,
  renderGroupedTestComparison,
  resolveGroupKey,
  resolveTestArea,
} from "../../scripts/lib/test-group-report.mts";
import {
  parseTestGroupReportArgs,
  resolveFullSuiteVitestEnv,
  resolveReportRunSpecs,
  resolveReportVitestArgs,
  resolveRunPlanConcurrency,
  resolveRunPlans,
  runReportPlans,
  spawnText,
} from "../../scripts/test-group-report.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withEnv } from "../../src/test-utils/env.js";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { withinTest } from "../helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";
import { childTermination } from "./run-vitest.test-support.js";
import { toolingProbeRuntimeEntrypoints } from "./tooling-probe-runtime.test-support.mts";

const tempDirs = new Set<string>();
const reportUrl = resolveRuntimeWorkerUrl(toolingProbeRuntimeEntrypoints.testGroupReport);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close().finally(() => cleanupTempDirs(tempDirs));
});

function fixtureReadyBeforeSettlement(
  filePath: string,
  operation: PromiseLike<unknown>,
  message = `timeout waiting for ${filePath}`,
) {
  const recorded = () => fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").trim();
  return Promise.race([
    receipts.waitFor(filePath, "ready"),
    // Product completion can overtake the socket; the fixture writes before reporting ready.
    Promise.resolve(operation).then(
      () => {
        if (!recorded()) {
          throw new Error(message);
        }
      },
      (error: unknown) => {
        if (!recorded()) {
          throw error;
        }
      },
    ),
  ]);
}

// spawnText can finish after signaling a foreign descendant without joining its extinction.
async function waitForProcessExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessAlive(pid)) {
      await delay(5, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`process still alive: ${pid}`, { cause: error });
    }
    throw error;
  }
}

function runReportCli(args: string[], env = process.env) {
  return spawnSync(
    process.execPath,
    [...resolveRuntimeWorkerArgv(reportUrl, process.execPath), ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    },
  );
}

function runNodeText(source: string[], options: Parameters<typeof spawnText>[2]) {
  return spawnText(process.execPath, ["--input-type=module", "--eval", source.join("\n")], {
    cwd: process.cwd(),
    env: process.env,
    ...options,
  });
}

function runnerArgv(source: string[]) {
  return [
    ...resolveRuntimeWorkerArgv(reportUrl, process.execPath).slice(0, -1),
    "--input-type=module",
    "--eval",
    source.join("\n"),
  ];
}

const readPid = (file: string) =>
  fs.existsSync(file) ? Number.parseInt(fs.readFileSync(file, "utf8"), 10) : undefined;

function processFixture() {
  const root = makeTempDir(tempDirs, "openclaw-test-group-report-");
  const pidPath = path.join(root, "child.pid");
  return {
    pidPath,
    readyPath: path.join(root, "child.ready"),
    cleanupPath: path.join(root, "child.cleanup"),
    childSource(setup: string[]) {
      return [
        "import fs from 'node:fs';",
        fixtureReceiptClientSource(receipts.endpoint),
        ...setup,
        "setInterval(() => {}, 1000);",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        `sendReceipt(${JSON.stringify(pidPath)}, "ready");`,
      ].join("\n");
    },
    async cleanup(signal: AbortSignal, settle: () => PromiseLike<unknown> | undefined) {
      try {
        await settle();
      } finally {
        // Recover ownership even when cancellation interrupted the readiness receipt.
        const pid = readPid(pidPath);
        killPidIfAlive(pid);
        if (pid !== undefined) {
          await waitForProcessExit(pid, signal);
        }
      }
    },
  };
}

function startRunner(source: string[]) {
  const runner = spawn(process.execPath, runnerArgv(source), {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { runner, closed: childTermination(runner) };
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function reportPaths() {
  const root = makeTempDir(tempDirs, "openclaw-test-group-report-");
  const file = (name: string) => path.join(root, `${name}.json`);
  return {
    before: file("before"),
    after: file("after"),
    input: file("input"),
    output: file("output"),
  };
}

function emptyGroupedReport() {
  return {
    command: "test-group-report",
    groupBy: "area",
    totals: counter(0, 0, 0),
    groups: [],
    configs: [],
    topFiles: [],
    slowTests: [],
    runs: [],
  };
}

function expectCliFailure(args: string[], output: string, ...messages: string[]) {
  const result = runReportCli([...args, "--output", output]);
  expect(result.status).toBe(1);
  for (const message of messages) {
    expect(result.stderr).toContain(message);
  }
  expect(fs.existsSync(output)).toBe(false);
}

function testResult(file: string, times: [number?, number?], cases: [string, number][]) {
  return {
    name: path.join(process.cwd(), file),
    startTime: times[0],
    endTime: times[1],
    assertionResults: cases.map(([fullName, duration]) => ({
      fullName,
      duration,
      status: "passed",
    })),
  };
}

function runPlans(
  root: string,
  labels: string[],
  flags: string[],
  runVitestJsonReport: Parameters<typeof runReportPlans>[0]["runVitestJsonReport"],
) {
  return runReportPlans({
    args: parseTestGroupReportArgs([
      ...labels.flatMap((label) => ["--config", `${label}.config.ts`]),
      ...flags,
      "--no-rss",
    ]),
    logDir: path.join(root, "logs"),
    reportDir: path.join(root, "reports"),
    runPlans: labels.map((label) => ({ config: `${label}.config.ts`, forwardedArgs: [], label })),
    runVitestJsonReport,
  });
}

function reportRun(
  params: { config: string; label: string; logPath: string; reportPath: string },
  status: number,
) {
  return {
    config: params.config,
    label: params.label,
    logPath: params.logPath,
    reportPath: params.reportPath,
    elapsedMs: 10,
    maxRssBytes: null,
    status,
  };
}

const counter = (durationMs: number, fileCount: number, testCount: number) => ({
  durationMs,
  fileCount,
  testCount,
});
const keyedCounter = (key: string, durationMs: number, fileCount: number, testCount: number) => ({
  key,
  ...counter(durationMs, fileCount, testCount),
});
const fileCounter = (file: string, group: string, durationMs: number, testCount: number) => ({
  config: "commands",
  file,
  group,
  durationMs,
  testCount,
});
const runCounter = (elapsedMs: number, rssMb: number) => ({
  config: "test/vitest/vitest.commands.config.ts",
  elapsedMs,
  maxRssBytes: 1024 * 1024 * rssMb,
  status: 0,
});

function expectedArgs(overrides: Partial<ReturnType<typeof parseTestGroupReportArgs>>) {
  return {
    allowFailures: false,
    compare: null,
    concurrency: null,
    configs: [],
    fullSuite: false,
    groupBy: "area",
    killGraceMs: 10000,
    limit: 25,
    maxTestMs: null,
    output: null,
    reports: [],
    rss: process.platform !== "win32",
    timeoutMs: 1800000,
    topFiles: 25,
    vitestArgs: [],
    ...overrides,
  };
}

describe("scripts/test-group-report", () => {
  it("groups repo files by stable product area", () => {
    expect(resolveTestArea("packages/plugin-sdk/src/index.test.ts")).toBe("packages/plugin-sdk");
    expect(resolveTestArea("ui/src/ui/views/chat.test.ts")).toBe("ui/views");
    expect(resolveTestArea("test/scripts/test-group-report.test.ts")).toBe("test/scripts");
  });

  it("supports folder and top-level grouping modes", () => {
    expect(resolveGroupKey("src/commands/agent.test.ts", "folder")).toBe("src/commands");
    expect(resolveGroupKey("extensions/browser/src/browser/pw.test.ts", "folder")).toBe(
      "extensions/browser/src",
    );
    expect(resolveGroupKey("extensions/browser/src/browser/pw.test.ts", "top")).toBe("extensions");
  });
  it.each([false, true])("reports measured duration limits in Actions mode %s", (actions) => {
    const root = makeTempDir(tempDirs, "openclaw-test-duration-limit-");
    const input = path.join(root, "input.json");
    const output = path.join(root, "output.json");
    const summary = path.join(root, "summary.md");
    writeJson(input, {
      testResults: [testResult("src/slow.test.ts", [0, 20], [["slow fixture", 20]])],
    });
    const result = runReportCli(["--report", input, "--output", output, "--max-test-ms", "10"], {
      ...process.env,
      CI: "1",
      GITHUB_ACTIONS: actions ? "true" : "",
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.status, result.stderr).toBe(actions ? 0 : 1);
    expect(result.stderr).toContain("slow fixture: 20.0ms exceeds 10.0ms");
    expect(JSON.parse(fs.readFileSync(output, "utf8")).slowTests).toHaveLength(1);
    if (actions) {
      expect(result.stderr).toContain("::warning file=src/slow.test.ts,line=1,col=0");
      expect(fs.readFileSync(summary, "utf8")).toContain("Test duration budget");
    }
  });

  it("profiles a selected test through the real Node wrapper", async () => {
    const root = makeTempDir(tempDirs, "openclaw-test-group-report-cli-");
    const output = path.join(root, "group-report.json");
    const target = "src/shared/human-list.test.ts";
    const result = await spawnText(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(reportUrl, process.execPath),
        "--config",
        "test/vitest/vitest.unit-fast.config.ts",
        "--no-rss",
        "--output",
        output,
        "--",
        target,
      ],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: "--max-old-space-size=512",
          OPENCLAW_VITEST_ENABLE_MAGLEV: "0",
          OPENCLAW_VITEST_INCLUDE_FILE: undefined,
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "cache"),
        },
        timeoutMs: 60_000,
      },
    );

    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
      totals: { fileCount: 1, testCount: expect.any(Number) },
      topFiles: [expect.objectContaining({ file: target })],
      runs: [expect.objectContaining({ status: 0 })],
    });
  });

  it("aggregates file durations by group and config", () => {
    const report = buildGroupedTestReport({
      groupBy: "area",
      reports: [
        {
          config: "test/vitest/vitest.commands.config.ts",
          report: {
            testResults: [
              testResult(
                "src/commands/agent.test.ts",
                [100, 700],
                [
                  ["agent ok", 150],
                  ["agent slow", 2600],
                ],
              ),
              testResult("extensions/discord/src/send.test.ts", [200, 450], [["send ok", 50]]),
            ],
          },
        },
      ],
      maxTestMs: 2000,
    });

    expect(report.totals).toEqual({ durationMs: 850, fileCount: 2, testCount: 3 });
    expect(report.groups.map((group) => [group.key, group.durationMs])).toEqual([
      ["src/commands", 600],
      ["extensions/discord", 250],
    ]);
    expect(report.configs).toStrictEqual([
      { configs: ["commands"], ...keyedCounter("commands", 850, 2, 3) },
    ]);
    expect(report.slowTests).toStrictEqual([
      {
        config: "commands",
        durationMs: 2600,
        file: "src/commands/agent.test.ts",
        fullName: "agent slow",
        status: "passed",
      },
    ]);
  });

  it.each([
    { payload: undefined, errors: ["missing JSON report for input"] },
    { payload: {}, errors: ["invalid JSON report for input", "missing testResults array"] },
    {
      payload: { testResults: [] },
      errors: ["invalid JSON report for input", "empty testResults array"],
    },
  ])("rejects absent or malformed report inputs %#", ({ payload, errors }) => {
    const { input, output } = reportPaths();
    if (payload !== undefined) {
      writeJson(input, payload);
    }
    const [headline, ...details] = errors;
    expectCliFailure(["--report", input], output, `[test-group-report] ${headline}`, ...details);
  });

  it("fails when every allow-failures run produces no JSON report", () => {
    const { input, output } = reportPaths();
    expectCliFailure(
      ["--config", input, "--allow-failures", "--no-rss", "--timeout-ms", "5000"],
      output,
      "[test-group-report] missing JSON report for failed config",
    );
  });

  it.each(["missing", "empty"])(
    "continues allow-failures profiling after a %s report",
    async (failedReport) => {
      const tempDir = makeTempDir(tempDirs, "openclaw-test-group-report-");
      const calls: string[] = [];
      const result = await runPlans(
        tempDir,
        ["failed", "passed"],
        ["--allow-failures"],
        async (params) => {
          calls.push(params.label);
          if (params.label === "passed" || failedReport === "empty") {
            writeJson(params.reportPath, {
              testResults: params.label === "passed" ? [{ name: "passed.test.ts" }] : [],
            });
          }
          return reportRun(params, params.label === "failed" ? 1 : 0);
        },
      );
      expect(calls).toStrictEqual(["failed", "passed"]);
      expect(result).toMatchObject({ failed: true, exitCode: 0 });
      expect(result.runs.map((run) => [run.label, run.status])).toStrictEqual([
        ["failed", 1],
        ["passed", 0],
      ]);
      expect(result.runEntries.map((entry) => entry.config)).toStrictEqual(["passed"]);
    },
  );

  it("stops admitting report plans after a parallel failure", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-test-group-report-");
    const labels = ["first", "second", "third"];
    const started: string[] = [];
    const resolvers = new Map<string, (status: number) => void>();
    const runPromise = runPlans(tempDir, labels, ["--concurrency", "2"], async (params) => {
      started.push(params.label);
      const status = await new Promise<number>((resolve) => {
        resolvers.set(params.label, resolve);
      });
      return reportRun(params, status);
    });

    await vi.waitFor(() => {
      expect(started).toStrictEqual(["first", "second"]);
    });
    resolvers.get("first")?.(1);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(started).toStrictEqual(["first", "second"]);
    resolvers.get("second")?.(0);

    const result = await runPromise;
    expect(result).toMatchObject({ exitCode: 1, failed: true });
    expect(result.runs.map((run) => run.label)).toStrictEqual(["first", "second"]);
  });

  it("prints slow tests as soon as each config report completes", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-test-group-report-");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPlans(tempDir, ["slow"], ["--max-test-ms", "1000"], async (params) => {
        writeJson(params.reportPath, {
          testResults: [testResult("src/slow.test.ts", [], [["finishes eventually", 1250]])],
        });
        return reportRun(params, 0);
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "slow-test config=slow duration=1250.0ms file=src/slow.test.ts name=finishes eventually",
        ),
      );
    } finally {
      logSpy.mockRestore();
    }
  });
  it("compares grouped reports by group, file, config, and run metrics", () => {
    const comparison = buildGroupedTestComparison({
      beforePath: "before.json",
      afterPath: "after.json",
      before: {
        groupBy: "area",
        totals: counter(1000, 2, 4),
        groups: [
          keyedCounter("src/commands", 700, 1, 2),
          keyedCounter("extensions/discord", 300, 1, 2),
        ],
        configs: [keyedCounter("commands", 1000, 2, 4)],
        topFiles: [
          fileCounter("src/commands/agent.test.ts", "src/commands", 700, 2),
          fileCounter("extensions/discord/src/send.test.ts", "extensions/discord", 300, 2),
        ],
        runs: [runCounter(2000, 100)],
      },
      after: {
        groupBy: "area",
        totals: counter(900, 2, 5),
        groups: [keyedCounter("src/commands", 900, 2, 5)],
        configs: [keyedCounter("commands", 900, 2, 5)],
        topFiles: [
          fileCounter("src/commands/agent.test.ts", "src/commands", 800, 3),
          fileCounter("src/commands/new.test.ts", "src/commands", 100, 2),
        ],
        runs: [runCounter(1800, 80)],
      },
    });

    expect(comparison.totals.delta).toEqual({ durationMs: -100, fileCount: 0, testCount: 1 });
    const commandsGroup = comparison.groups.find((group) => group.key === "src/commands");
    expect(commandsGroup?.delta).toStrictEqual({ durationMs: 200, fileCount: 1, testCount: 3 });
    const removedDiscordFile = comparison.files.find(
      (file) => file.file === "extensions/discord/src/send.test.ts",
    );
    expect(removedDiscordFile?.status).toBe("removed");
    expect(removedDiscordFile?.delta).toStrictEqual({ durationMs: -300, testCount: -2 });
    expect(comparison.runs[0]?.key).toBe("commands");
    expect(comparison.runs[0]?.delta).toStrictEqual({
      elapsedMs: -200,
      maxRssBytes: -1024 * 1024 * 20,
    });

    expect(renderGroupedTestComparison(comparison, { limit: 2, topFiles: 2 })).toContain(
      "Top group regressions",
    );
  });

  it("keeps sharded run labels distinct in comparisons", () => {
    const report = (firstMs: number, secondMs: number) => ({
      ...emptyGroupedReport(),
      runs: [firstMs, secondMs].map((elapsedMs, index) => ({
        config: "test/vitest/vitest.gateway-server.config.ts",
        label: `gateway-server-${index + 1}`,
        elapsedMs,
        status: 0,
      })),
    });
    const comparison = buildGroupedTestComparison({
      before: report(100, 200),
      after: report(110, 220),
    });

    expect(comparison.runs.map((run) => run.key).toSorted()).toEqual([
      "gateway-server-1",
      "gateway-server-2",
    ]);
  });

  it.each([
    [{}, ["[test-group-report] invalid grouped report", "command must be test-group-report"]],
    [emptyGroupedReport(), ["no evidence rows"]],
  ])("rejects invalid comparison evidence %#", (payload, errors) => {
    const { before, after, output } = reportPaths();
    writeJson(before, payload);
    writeJson(after, {
      ...emptyGroupedReport(),
      totals: counter(100, 1, 1),
      groups: [{ configs: ["unit-fast"], ...keyedCounter("test/scripts", 100, 1, 1) }],
    });
    expectCliFailure(["--compare", before, after], output, ...errors);
  });
  it.each([
    {
      command:
        "--config a.ts --config b.ts --group-by folder --allow-failures -- --maxWorkers=1 -- --limit 99",
      expected: {
        allowFailures: true,
        configs: ["a.ts", "b.ts"],
        groupBy: "folder",
        vitestArgs: ["--maxWorkers=1", "--", "--limit", "99"],
      },
    },
    {
      command: "--compare before.json after.json --limit 5 --top-files 3",
      expected: {
        compare: { before: "before.json", after: "after.json" },
        limit: 5,
        topFiles: 3,
      },
    },
  ])("parses valid report arguments %#", ({ command, expected }) => {
    expect(parseTestGroupReportArgs(command.split(" "))).toStrictEqual(expectedArgs(expected));
  });

  it.each([
    { command: "--help --unknown", error: "Unknown option: --unknown" },
    { command: "--help --limit", error: "--limit requires a value" },
    ...["--config", "--output"].flatMap((flag) => [
      { command: `${flag} --limit 5`, error: `${flag} requires a value` },
      { command: `${flag} -h`, error: `${flag} requires a value` },
    ]),
    { command: "--limit", error: "--limit requires a value" },
    { command: "--limit --output report.json", error: "--limit requires a value" },
    { command: "--compare before.json --limit", error: "--compare requires a value" },
    { command: "--compare --limit 5", error: "--compare requires a value" },
    {
      command: "--compare before-a.json after-a.json --compare before-b.json after-b.json",
      error: "--compare was provided more than once",
    },
  ])("rejects invalid report arguments $command", ({ command, error }) => {
    expect(() => parseTestGroupReportArgs(command.split(" "))).toThrow(error);
  });
  it("keeps timed wrappers alive through SIGKILL without orphaning their descendants", async () => {
    if (process.platform === "win32" || !fs.existsSync("/usr/bin/time")) {
      return;
    }

    const tempDir = makeTempDir(tempDirs, "openclaw-test-group-report-");
    const childPidPath = path.join(tempDir, "child.pid");
    const markerPath = path.join(tempDir, "marker.txt");
    let childPid: number | undefined;
    try {
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "process.on('SIGHUP', () => {});",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        `setInterval(() => fs.appendFileSync(${JSON.stringify(markerPath)}, "x"), 5);`,
      ].join("\n");
      const result = spawnSync(
        process.execPath,
        runnerArgv([
          `import { spawnText } from ${JSON.stringify(reportUrl.href)};`,
          "const result = await spawnText(",
          '  "/usr/bin/time",',
          `  [process.execPath, "--eval", ${JSON.stringify(childScript)}],`,
          "  { cwd: process.cwd(), env: process.env, killGraceMs: 25, timeoutMs: 500 },",
          ");",
          "process.stdout.write(JSON.stringify(result));",
        ]),
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      childPid = readPid(childPidPath);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toBe("");
      const parsed = JSON.parse(result.stdout) as Awaited<ReturnType<typeof spawnText>>;
      expect(parsed).toMatchObject({
        status: 1,
        timedOut: true,
      });
      expect(parsed.output).toContain("sending SIGKILL");
      expect(parsed.output).toContain("command timed out after 500ms");
      const sizeAfterReturn = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
      await delay(40);
      expect(fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0).toBe(sizeAfterReturn);
    } finally {
      killPidIfAlive(childPid);
    }
  });

  it.concurrent("cleans process-group descendants before forwarding parent SIGTERM", async ({
    signal,
  }) => {
    if (process.platform === "win32") {
      return;
    }

    const fixture = processFixture();
    const { pidPath: childPidPath, readyPath } = fixture;
    let started: ReturnType<typeof startRunner> | undefined;
    try {
      const childScript = fixture.childSource(["process.on('SIGTERM', () => {});"]);
      const parentScript = [
        "import { spawn } from 'node:child_process';",
        "import fs from 'node:fs';",
        fixtureReceiptClientSource(receipts.endpoint),
        `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
        "process.on('SIGTERM', () => process.exit(0));",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        `sendReceipt(${JSON.stringify(readyPath)}, "ready");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const runnerSource = [
        `import { spawnText } from ${JSON.stringify(reportUrl.href)};`,
        "await spawnText(",
        "  process.execPath,",
        `  ["--input-type=module", "--eval", ${JSON.stringify(parentScript)}],`,
        "  { cwd: process.cwd(), env: process.env, killGraceMs: 5_000, timeoutMs: 60_000 },",
        ");",
      ];

      started = startRunner(runnerSource);
      const { runner, closed: runnerClosed } = started;
      await withinTest(fixtureReadyBeforeSettlement(readyPath, runnerClosed), signal);
      await withinTest(fixtureReadyBeforeSettlement(childPidPath, runnerClosed), signal);
      const childPid = expectDefined(readPid(childPidPath), "child PID");
      expect(isProcessAlive(childPid)).toBe(true);

      runner.kill("SIGTERM");

      await expect(withinTest(runnerClosed, signal)).resolves.toEqual({
        code: null,
        signal: "SIGTERM",
      });
      await waitForProcessExit(childPid, signal);
    } finally {
      if (started?.runner.pid && isProcessAlive(started.runner.pid)) {
        started.runner.kill("SIGTERM");
      }
      await fixture.cleanup(signal, () => started?.closed);
    }
  });

  it.concurrent("finishes promptly when timed process-group descendants exit cleanly", async ({
    signal,
  }) => {
    if (process.platform === "win32") {
      return;
    }

    const fixture = processFixture();
    const { pidPath: childPidPath, cleanupPath } = fixture;
    const childScript = fixture.childSource([
      "process.on('SIGTERM', () => {",
      "  setTimeout(() => {",
      `    fs.writeFileSync(${JSON.stringify(cleanupPath)}, "clean");`,
      "    process.exit(0);",
      "  }, 25);",
      "});",
    ]);
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => process.exit(0));",
      `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    let completion: ReturnType<typeof spawnText> | undefined;
    const releaseAndWait = startProcessWatchdogFixture(
      () =>
        (completion = spawnText(process.execPath, ["--eval", parentScript], {
          cwd: process.cwd(),
          env: process.env,
          killGraceMs: 250,
          timeoutMs: 250,
        })),
    );
    try {
      await withinTest(
        fixtureReadyBeforeSettlement(
          childPidPath,
          expectDefined(completion, "watchdog completion"),
          `timeout waiting for pid in ${childPidPath}`,
        ),
        signal,
      );
      const childPid = expectDefined(readPid(childPidPath), "child PID");
      const startedAt = Date.now();
      const result = await withinTest(releaseAndWait(), signal);

      expect(result).toMatchObject({
        status: 1,
        signal: null,
        timedOut: true,
      });
      expect(fs.readFileSync(cleanupPath, "utf8")).toBe("clean");
      expect(Date.now() - startedAt).toBeLessThan(900);
      await waitForProcessExit(childPid, signal);
    } finally {
      await fixture.cleanup(signal, releaseAndWait);
    }
  });

  it.concurrent.each([
    { mode: "large log", status: 0, message: "Maximum resident set size (kbytes): 12345" },
    { mode: "bounded tail", status: 1, message: "output exceeded 1048576 bytes" },
    { mode: "log cap", status: 1, message: "output log exceeded 1048576 bytes" },
  ])("bounds child output: $mode", async ({ mode, status, message }) => {
    const tempDir = makeTempDir(tempDirs, "openclaw-test-group-report-log-");
    const logPath = path.join(tempDir, "child.log");
    const capped = mode === "log cap";
    const logged = mode !== "bounded tail";
    const result = await runNodeText(
      [
        ...(capped ? ["process.on('SIGTERM', () => {});"] : []),
        "const chunk = Buffer.alloc(1024 * 1024, 120);",
        capped
          ? "setInterval(() => process.stdout.write(chunk), 1);"
          : `for (let index = 0; index < ${logged ? 65 : 3}; index += 1) process.stdout.write(chunk);`,
        ...(mode === "large log"
          ? ['process.stderr.write("Maximum resident set size (kbytes): 12345\\n");']
          : []),
      ],
      {
        killGraceMs: 50,
        ...(logged ? { logPath } : { maxBufferBytes: 1024 * 1024 }),
        ...(capped ? { maxLogBytes: 1024 * 1024 } : {}),
        outputTailBytes: 4096,
        timeoutMs: 10_000,
      },
    );
    expect(result.status).toBe(status);
    expect(result.output).toContain(message);
    if (capped) {
      expect(result.signal).toBe("SIGKILL");
      expect(fs.statSync(logPath).size).toBeLessThan(2 * 1024 * 1024);
    } else {
      expect(result.output.length).toBeLessThan(8 * 1024);
      if (logged) {
        expect(fs.statSync(logPath).size).toBeGreaterThan(64 * 1024 * 1024);
      }
    }
  });
  const fullSuitePlans = (env: NodeJS.ProcessEnv) =>
    withEnv(env, () => resolveRunPlans(parseTestGroupReportArgs(["--full-suite"])));

  it.each([
    [["--full-suite"], ["--isolate=true"]],
    [
      ["--full-suite", "--", "--maxWorkers=1"],
      ["--maxWorkers=1", "--isolate=true"],
    ],
    [["--full-suite", "--", "--no-isolate"], ["--no-isolate"]],
    [["--full-suite", "--", "--isolate=false"], ["--isolate=false"]],
    [["--config", "a.ts"], []],
  ])("resolves report isolation for %j", (args, expected) => {
    expect(resolveReportVitestArgs(parseTestGroupReportArgs(args))).toEqual(expected);
  });

  it.each([
    { env: {}, config: undefined, expected: { OPENCLAW_VITEST_MAX_WORKERS: "2" } },
    { env: {}, config: "commands", expected: { OPENCLAW_VITEST_MAX_WORKERS: "1" } },
    { env: { OPENCLAW_VITEST_MAX_WORKERS: "2" }, config: undefined, expected: {} },
    { env: { OPENCLAW_TEST_WORKERS: "2" }, config: undefined, expected: {} },
  ])("resolves profiling worker budget %#", ({ env, config, expected }) => {
    expect(
      resolveFullSuiteVitestEnv(parseTestGroupReportArgs(["--full-suite"]), env, config),
    ).toEqual(expected);
  });

  it.each([
    { args: ["--config", "a", "--config", "b"], plans: 2, expected: 2 },
    { args: ["--full-suite"], plans: 8, expected: 1 },
    { args: ["--full-suite", "--concurrency", "3"], plans: 8, expected: 3 },
    { args: ["--concurrency", "9"], plans: 2, expected: 2 },
  ])("caps report concurrency for $args", ({ args, plans, expected }) => {
    expect(resolveRunPlanConcurrency(parseTestGroupReportArgs(args), plans)).toBe(expected);
  });

  it("isolates Vitest filesystem module caches for parallel report configs", () => {
    const plans = [
      { config: "a.ts", forwardedArgs: [], label: "a" },
      { config: "b.ts", forwardedArgs: [], label: "b" },
      { config: "a.ts", forwardedArgs: [], label: "a-again" },
    ];
    const specs = resolveReportRunSpecs(
      parseTestGroupReportArgs(plans.flatMap(({ config }) => ["--config", config])),
      plans,
      { cwd: "/repo", env: {} },
    );

    const cachePaths = specs.map((spec) =>
      expectDefined(spec.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH, "report cache path"),
    );
    expect(new Set(cachePaths).size).toBe(3);
    for (const cachePath of cachePaths) {
      const relative = path.relative(path.join("/repo", ".cache", "vitest"), cachePath);
      expect(relative).not.toBe("");
      expect(path.isAbsolute(relative)).toBe(false);
      expect(relative.split(path.sep)).not.toContain("..");
      expect(cachePaths.filter((other) => other.startsWith(`${cachePath}${path.sep}`))).toEqual([]);
    }
    expect(specs.map((spec) => spec.vitestArgs)).toEqual([[], [], []]);
  });

  it("uses leaf configs for full-suite profiling without requiring parallel env", () => {
    const serialFullSuitePlans = fullSuitePlans({
      OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
      OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
    });
    expect(serialFullSuitePlans.map((plan) => plan.config)).not.toContain(
      "test/vitest/vitest.full-agentic.config.ts",
    );
    expect(serialFullSuitePlans.map((plan) => plan.config)).toContain(
      "test/vitest/vitest.agents-tools.config.ts",
    );
  });

  it("preserves full-suite shard file args and unique report labels", () => {
    const gatewayServerPlans = fullSuitePlans({ OPENCLAW_TEST_PROJECTS_PARALLEL: "6" }).filter(
      (plan) => plan.config === "test/vitest/vitest.gateway-server.config.ts",
    );

    expect(gatewayServerPlans.length).toBeGreaterThan(1);
    expect(new Set(gatewayServerPlans.map((plan) => plan.label)).size).toBe(
      gatewayServerPlans.length,
    );
    expect(gatewayServerPlans.every((plan) => plan.forwardedArgs.length > 0)).toBe(true);
    expect(gatewayServerPlans.flatMap((plan) => plan.forwardedArgs)).toContain(
      "src/gateway/server.node-pairing-authz.test.ts",
    );
  });
});
