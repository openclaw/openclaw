import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

type ChildReceipt = {
  exitCode: number | null;
  signal: string | null;
  exitedBeforeTeardown: boolean;
};
type ProcessSnapshot = {
  pid?: number;
  exitEvent?: { exitCode: number | null; signal: string | null };
  closeEvent?: { exitCode: number | null; signal: string | null };
};
type RunReport = {
  freshConnection: { ok: boolean } | null;
  gatewayExit?: ChildReceipt;
  gatewayProcess?: ProcessSnapshot;
  history: Array<{ ok: boolean; error: string | null }>;
  memory: { before: unknown; after: unknown; peakRssMb: number | null };
  cpuUsage: unknown;
  pluginMetadataScans?: { count: number; durationMs: unknown; totalDurationMs: number };
  probeWarmup: { samples: Array<{ sessionsList: { ok: boolean; error: string | null } }> };
  readyz: Array<{ ok: boolean }>;
  sessionsList: Array<{ ok: boolean }>;
  turnAccounting: { launched: number; terminalOk: number; verified: number };
  turnCount?: number;
};
type Report = {
  mode: string;
  runs: RunReport[];
  warmupRuns: RunReport[];
  failedAttempt: {
    status: "failure";
    phase: "measured";
    index: number;
    errors: Array<{ phase: "workload" | "diagnostics" | "cleanup"; error: string }>;
    partialRun: RunReport;
    cleanup: { rootRemoved: boolean | null };
    mockProviderExit?: ChildReceipt;
    mockProviderProcess?: ProcessSnapshot;
  };
  summary: { pluginMetadataScanCount: number | null; turnCount: number };
};
type OwnedChild = { role: "gateway" | "mock"; pid: number; startTime: number | null; root: string };

async function withBenchmark(
  scenario: "workload" | "teardown" | "history" | "diagnostic",
  check: (report: Report) => void,
) {
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
        "--concurrency",
        "1",
        "--runs",
        scenario === "workload" ? "3" : "1",
        "--warmup",
        "0",
        "--cadence-ms",
        "10",
        "--timeout-ms",
        "5000",
        "--output",
        output,
        "--json",
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
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-gateway-concurrency] FAILED (exit 1)",
    );
    expect(result.stderr).toContain(
      {
        workload: "agent 1 did not complete",
        history: "all configured chat.history load probes failed",
        teardown: "Gateway did not exit cleanly",
        diagnostic: "Activity-summary diagnostic benchmark failed",
      }[scenario],
    );
    expect(existsSync(output), `failed benchmark did not write JSON:\n${result.stderr}`).toBe(true);
    const report = JSON.parse(readFileSync(output, "utf8")) as Report;
    expect(JSON.parse(result.stdout)).toEqual(report);
    expect(report.mode).toBe(
      scenario === "diagnostic" ? "mock-activity-summary-diagnostics" : "mock-streaming-agent",
    );
    expect(report.warmupRuns).toEqual([]);
    expect(report.failedAttempt).toMatchObject({
      status: "failure",
      phase: "measured",
      index: scenario === "workload" ? 2 : 1,
      cleanup: { rootRemoved: true },
    });
    expect(children.map((child) => child.role)).toEqual(
      scenario === "workload" ? ["mock", "gateway", "mock", "gateway"] : ["mock", "gateway"],
    );
    for (const child of children) {
      expect(child.startTime).not.toBeNull();
      expect(inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })).toBe("dead");
      if (child.role === "gateway") {
        expect(existsSync(child.root)).toBe(false);
      }
    }
    expect(readdirSync(tempRoot)).toEqual([]);
    expect(report.failedAttempt.mockProviderExit).toBeDefined();
    expect(report.failedAttempt.mockProviderProcess?.exitEvent).toBeDefined();
    expect(report.failedAttempt.partialRun.gatewayProcess?.closeEvent).toBeDefined();
    check(report);
    if (scenario === "diagnostic") {
      const sidecar = readFileSync(`${output}.failure.json`, "utf8");
      expect(JSON.parse(sidecar)).toMatchObject({
        mode: "mock-activity-summary-diagnostics",
        status: "failed",
      });
      expect(
        `${readFileSync(output, "utf8")}${result.stdout}${result.stderr}${sidecar}`,
      ).not.toContain(diagnosticPrivateMarker);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    const cleanups = await Promise.allSettled(
      children.map(async (child) => {
        if (inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }) !== "dead") {
          if (
            child.startTime === null ||
            getFileLockProcessStartTime(child.pid) !== child.startTime
          ) {
            throw new Error("Child identity unavailable or changed; refusing cleanup signal");
          }
          terminateManagedChild(
            { pid: child.pid, kill: (signal) => process.kill(child.pid, signal) },
            "SIGKILL",
            { processGroupFallback: "never" },
          );
          expect(
            await waitForManagedProcessGroupExit(child, 5_000, { errorPolicy: "indeterminate" }),
          ).toBe(true);
        }
      }),
    );
    for (const cleanup of cleanups) {
      if (cleanup.status === "rejected") {
        errors.push(cleanup.reason);
      }
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Benchmark validation or cleanup failed");
  }
}

describe.skipIf(process.platform === "win32")("gateway concurrency CLI failure evidence", () => {
  it("omits private warmup probe errors from diagnostic failure evidence", async () => {
    await withBenchmark("diagnostic", (report) => {
      const { errors, partialRun } = report.failedAttempt;
      expect(partialRun.probeWarmup.samples[0]?.sessionsList).toMatchObject({
        ok: false,
        error: expect.any(String),
      });
      expect(partialRun.probeWarmup.samples.some((sample) => sample.sessionsList.ok)).toBe(true);
      expect(partialRun.turnAccounting).toEqual({ launched: 1, terminalOk: 0, verified: 0 });
      expect(errors).toContainEqual({
        phase: "workload",
        error: expect.stringContaining("raw output omitted"),
      });
    });
  });

  it("retains completed runs and partial probes when a later accepted turn fails", async () => {
    await withBenchmark("workload", (report) => {
      expect(report.runs).toHaveLength(1);
      const completed = report.runs[0]!;
      expect(completed).not.toHaveProperty("failures");
      expect(completed).not.toHaveProperty("cleanup");
      expect(completed.freshConnection).toMatchObject({ ok: true });
      expect(completed.memory).toMatchObject({
        before: { heapUsedMb: 4, rssMb: 16 },
        after: { heapUsedMb: 4, rssMb: 16 },
      });
      expect(completed.pluginMetadataScans).toEqual({
        count: 0,
        durationMs: null,
        totalDurationMs: 0,
      });
      expect(report.summary).toMatchObject({ turnCount: 1, pluginMetadataScanCount: 0 });
      const { errors, partialRun } = report.failedAttempt;
      expect(errors).toContainEqual({
        phase: "workload",
        error: expect.stringContaining("agent 1 did not complete"),
      });
      expect(partialRun.readyz.some((sample) => sample.ok)).toBe(true);
      expect(partialRun.sessionsList.some((sample) => sample.ok)).toBe(true);
      expect(partialRun.memory.before).toMatchObject({ heapUsedMb: 4, rssMb: 16 });
      expect(partialRun.turnAccounting).toEqual({ launched: 1, terminalOk: 0, verified: 0 });
      expect(partialRun.gatewayExit).toEqual({
        exitCode: 0,
        signal: null,
        exitedBeforeTeardown: false,
      });
    });
  });

  it("retains completed load when the Gateway exits nonzero during teardown", async () => {
    await withBenchmark("teardown", (report) => {
      expect(report.runs).toEqual([]);
      expect(report.summary.turnCount).toBe(0);
      const { errors, partialRun } = report.failedAttempt;
      expect(errors).toContainEqual({
        phase: "diagnostics",
        error: expect.stringContaining("Gateway did not exit cleanly"),
      });
      expect(partialRun.turnCount).toBe(1);
      expect(partialRun.freshConnection).toMatchObject({ ok: true });
      expect(partialRun.memory.after).toMatchObject({ heapUsedMb: 4, rssMb: 16 });
      expect(partialRun).not.toHaveProperty("pluginMetadataScans");
      expect(partialRun.gatewayExit).toEqual({
        exitCode: 23,
        signal: null,
        exitedBeforeTeardown: false,
      });
      expect(partialRun.gatewayProcess?.exitEvent).toMatchObject({ exitCode: 23, signal: null });
    });
  });

  it("retains completed history failures and their load timeline window", async () => {
    await withBenchmark("history", (report) => {
      expect(report.runs).toEqual([]);
      expect(report.summary.turnCount).toBe(0);
      const { errors, partialRun } = report.failedAttempt;
      expect(errors).toContainEqual({
        phase: "workload",
        error: expect.stringContaining("all configured chat.history load probes failed"),
      });
      expect(partialRun.history.length).toBeGreaterThan(0);
      expect(
        partialRun.history.every(
          (sample) => !sample.ok && sample.error?.includes("fixture history failure"),
        ),
      ).toBe(true);
      expect(partialRun.readyz.some((sample) => sample.ok)).toBe(true);
      expect(partialRun.memory.after).toMatchObject({ heapUsedMb: 4, rssMb: 16 });
      expect(partialRun.cpuUsage).toMatchObject({
        process: { totalMs: expect.any(Number) },
        mainThread: { totalMs: expect.any(Number) },
      });
      expect(partialRun.pluginMetadataScans).toMatchObject({ count: 1, totalDurationMs: 7 });
      expect(partialRun.gatewayExit).toEqual({
        exitCode: 0,
        signal: null,
        exitedBeforeTeardown: false,
      });
    });
  });
});
