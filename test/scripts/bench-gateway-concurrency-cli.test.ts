import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { testing } from "../../scripts/bench-gateway-concurrency.js";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import { getFileLockProcessStartTime } from "../../src/shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const testNodeExecPath = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const diagnosticPrivateMarker = "synthetic-private-probe at /private/fixture/probe-content";
const diagnosticMode = "mock-activity-summary-diagnostics";

type Samples = Awaited<ReturnType<typeof testing.runBenchmarkSamples>>;
type Report = Omit<Samples, "failedAttempt"> & {
  failedAttempt: NonNullable<Samples["failedAttempt"]>;
  summary: { turnCount: number };
};
type OwnedChild = { role: "gateway" | "mock"; pid: number; startTime: number | null; root: string };
const failureMessages = {
  workload: "agent 1 did not complete",
  history: "all configured chat.history load probes failed",
  teardown: "Gateway did not exit cleanly",
  diagnostic: "Activity-summary diagnostic benchmark failed",
};
const memorySample = { heapUsedMb: 4, rssMb: 16 };
const processInspection = { errorPolicy: "indeterminate" } as const;
type Scenario = keyof typeof failureMessages;

async function withBenchmark(scenario: Scenario) {
  const root = tempDirs.make("openclaw-concurrency-cli-");
  const tempRoot = path.join(root, "tmp");
  const entry = path.join(root, `${scenario}.mjs`);
  const output = path.join(root, "report.json");
  const receipts = path.join(root, "children.jsonl");
  const preload = path.join(root, "capture-spawn.mjs");
  mkdirSync(tempRoot);
  const fixture = new URL("./fixtures/gateway-concurrency-entry.mjs", import.meta.url);
  writeFileSync(entry, `import ${JSON.stringify(fixture.href)};\n`);
  mkdirSync(path.join(root, "gateway", "protocol"), { recursive: true });
  writeFileSync(
    path.join(root, "gateway", "protocol", "index.js"),
    "exports.PROTOCOL_VERSION = 3;\n",
  );
  writeFileSync(
    preload,
    `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { getFileLockProcessStartTime } from ${JSON.stringify(new URL("../../src/shared/pid-alive.ts", import.meta.url).href)};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const child = spawn(command, args, options);
  const role = args[0] === "scripts/e2e/mock-openai-server.mjs" ? "mock" : args.includes(${JSON.stringify(entry)}) ? "gateway" : null;
  if (role && child.pid) appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({ role, pid: child.pid, startTime: getFileLockProcessStartTime(child.pid), root: options.env.HOME ?? "" }) + "\\n");
  return child;
};
syncBuiltinESMExports();\n`,
  );
  let children: OwnedChild[] = [];
  const errors: unknown[] = [];
  try {
    const result = spawnSync(
      testNodeExecPath,
      [
        "--import",
        preload,
        "scripts/bench-gateway-concurrency.ts",
        "--entry",
        entry,
        ..."--concurrency 1 --warmup 0 --cadence-ms 10 --timeout-ms 5000 --json".split(" "),
        "--runs",
        scenario === "workload" ? "3" : "1",
        "--output",
        output,
        ...(scenario === "history" ? ["--history-clients", "1", "--history-burst", "1"] : []),
        ...(scenario === "diagnostic" ? ["--activity-summary-diagnostics"] : []),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    children = existsSync(receipts)
      ? readFileSync(receipts, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as OwnedChild)
      : [];
    expect([result.error, result.status], result.stderr).toEqual([undefined, 1]);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-gateway-concurrency] FAILED (exit 1)",
    );
    expect(result.stderr).toContain(failureMessages[scenario]);
    expect(existsSync(output), `failed benchmark did not write JSON:\n${result.stderr}`).toBe(true);
    const report = JSON.parse(readFileSync(output, "utf8")) as Report;
    expect(JSON.parse(result.stdout)).toEqual(report);
    expect(report).toMatchObject({
      mode: scenario === "diagnostic" ? diagnosticMode : "mock-streaming-agent",
      warmupRuns: [],
      failedAttempt: {
        status: "failure",
        phase: "measured",
        index: scenario === "workload" ? 2 : 1,
        cleanup: { rootRemoved: true },
      },
    });
    expect(children.map((child) => child.role)).toEqual(
      scenario === "workload" ? ["mock", "gateway", "mock", "gateway"] : ["mock", "gateway"],
    );
    for (const child of children) {
      expect(child.startTime).not.toBeNull();
      expect(inspectManagedProcessGroup(child, processInspection)).toBe("dead");
      if (child.role === "gateway") {
        expect(existsSync(child.root)).toBe(false);
      }
    }
    expect(readdirSync(tempRoot)).toEqual([]);
    expect(report.failedAttempt.mockProviderExit).toBeDefined();
    expect(report.failedAttempt.mockProviderProcess?.exitEvent).toBeDefined();
    expect(report.failedAttempt.partialRun.gatewayProcess?.closeEvent).toBeDefined();
    checkReport(report, scenario);
    if (scenario === "diagnostic") {
      const sidecar = readFileSync(`${output}.failure.json`, "utf8");
      expect(JSON.parse(sidecar)).toMatchObject({ mode: diagnosticMode, status: "failed" });
      expect(
        `${readFileSync(output, "utf8")}${result.stdout}${result.stderr}${sidecar}`,
      ).not.toContain(diagnosticPrivateMarker);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    const cleanups = await Promise.allSettled(
      children.map(async (child) => {
        if (inspectManagedProcessGroup(child, processInspection) === "dead") {
          return;
        }
        const { pid, startTime } = child;
        if (startTime === null || getFileLockProcessStartTime(pid) !== startTime) {
          throw new Error("Child identity unavailable or changed; refusing cleanup signal");
        }
        terminateManagedChild({ pid, kill: (signal) => process.kill(pid, signal) }, "SIGKILL", {
          processGroupFallback: "never",
        });
        expect(await waitForManagedProcessGroupExit(child, 5_000, processInspection)).toBe(true);
      }),
    );
    errors.push(
      ...cleanups.flatMap((cleanup) => (cleanup.status === "rejected" ? [cleanup.reason] : [])),
    );
  }
  if (errors.length) {
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, "Benchmark validation or cleanup failed");
  }
}

function checkReport(report: Report, scenario: Scenario) {
  const { errors, partialRun } = report.failedAttempt;
  expect(errors).toContainEqual({
    phase: scenario === "teardown" ? "diagnostics" : "workload",
    error: expect.stringContaining(
      scenario === "diagnostic" ? "raw output omitted" : failureMessages[scenario],
    ),
  });
  if (scenario === "diagnostic" || scenario === "workload") {
    expect(partialRun.turnAccounting).toEqual({ launched: 1, terminalOk: 0, verified: 0 });
  }
  if (scenario === "diagnostic") {
    expect(partialRun.probeWarmup.samples[0]?.sessionsList).toMatchObject({
      ok: false,
      error: expect.any(String),
    });
    expect(partialRun.probeWarmup.samples.some((sample) => sample.sessionsList.ok)).toBe(true);
    return;
  }
  expect(partialRun.gatewayExit).toEqual({
    exitCode: scenario === "teardown" ? 23 : 0,
    signal: null,
    exitedBeforeTeardown: false,
  });
  if (scenario !== "teardown") {
    expect(partialRun.readyz?.some((sample) => sample.ok)).toBe(true);
  }
  if (scenario === "workload") {
    expect(report.runs).toHaveLength(1);
    const completed = report.runs[0]!;
    const scans = completed.pluginMetadataScans;
    expect(completed).not.toHaveProperty("failures");
    expect(completed).not.toHaveProperty("cleanup");
    expect(completed).toMatchObject({
      freshConnection: { ok: true },
      memory: { before: memorySample, after: memorySample },
    });
    expect(scans).toEqual({ count: 0, durationMs: null, totalDurationMs: 0 });
    expect(report.summary).toMatchObject({ turnCount: 1, pluginMetadataScanCount: 0 });
    expect(partialRun.sessionsList?.some((sample) => sample.ok)).toBe(true);
    expect(partialRun.memory.before).toMatchObject(memorySample);
    return;
  }
  expect(report).toMatchObject({ runs: [], summary: { turnCount: 0 } });
  expect(partialRun.memory.after).toMatchObject(memorySample);
  if (scenario === "teardown") {
    expect(partialRun).toMatchObject({
      turnCount: 1,
      freshConnection: { ok: true },
      gatewayProcess: { exitEvent: { exitCode: 23, signal: null } },
    });
    expect(partialRun).not.toHaveProperty("pluginMetadataScans");
    return;
  }
  expect(partialRun.history?.length).toBeGreaterThan(0);
  expect(
    partialRun.history?.every(
      (sample) => !sample.ok && sample.error?.includes("fixture history failure"),
    ),
  ).toBe(true);
  expect(partialRun.cpuUsage).toMatchObject({
    process: { totalMs: expect.any(Number) },
    mainThread: { totalMs: expect.any(Number) },
  });
  expect(partialRun.pluginMetadataScans).toMatchObject({ count: 1, totalDurationMs: 7 });
}

it
  .skipIf(process.platform === "win32")
  .each(["diagnostic", "workload", "teardown", "history"] as const)(
  "retains partial evidence and cleans up after %s failure",
  withBenchmark,
);
