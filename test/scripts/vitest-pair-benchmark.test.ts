import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeBenchmark,
  assertEquivalentInventories,
  assertExecutionDigest,
  assertInventoryAvailable,
  assertSingleWorkflowAttempt,
  buildBenchmarkSchedule,
  loadBenchmarkManifest,
  parseVitestExecutionReport,
  validateBenchmarkManifest,
  withTerminalManifest,
  writeJsonAtomic,
  type BenchmarkManifest,
  type BenchmarkRunRecord,
} from "../../scripts/lib/vitest-pair-benchmark-contract.mts";
import {
  buildBenchmarkCommandEnv,
  resolvePackageManagerIdentity,
  runOwnedCommand,
  withVitestPairDeadline,
} from "../../scripts/lib/vitest-pair-benchmark.mts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const deadlineFixtureLifetime = createFixtureLifetime();
afterEach(() => deadlineFixtureLifetime.cleanup());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itUnix = it.runIf(process.platform !== "win32");
const packageManager = {
  executable: "/opt/vitest-pair/pnpm",
  resolvedExecutable: "/opt/vitest-pair/pnpm",
  version: "12.1.0",
};

const manifest: BenchmarkManifest = {
  version: 1,
  rounds: 7,
  thresholds: {
    overallWallRatio: 1.05,
    criticalLaneWallRatio: 1.1,
    criticalLaneWallDeltaMs: 1000,
    improvementRatio: 0.95,
    improvementPairCount: 5,
  },
  lanes: ["core", "gateway", "ui", "lifecycle"].map((id) => ({
    id,
    critical: true,
    files: [`src/${id}.test.ts`],
    config: id === "core" ? "test/core.config.ts" : undefined,
  })),
};

const execution = {
  digest: "a".repeat(64),
  fileCount: 1,
  assertionCount: 1,
  counts: {
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  },
  success: true as const,
};

type BenchmarkDurations = {
  baselineMs: number;
  candidateMs: number;
};

function recordsFor(
  durations: number | ((lane: string, round: number | null) => BenchmarkDurations),
): BenchmarkRunRecord[] {
  const durationsFor =
    typeof durations === "function"
      ? durations
      : () => ({ baselineMs: 100, candidateMs: 100 * durations });
  return buildBenchmarkSchedule(manifest)
    .filter(({ phase }) => phase === "measured" || phase === "cold")
    .map((plan) => {
      const times = durationsFor(plan.lane.id, plan.round);
      return Object.assign({}, plan, {
        lane: plan.lane.id,
        command: ["node"],
        packageManager,
        startedAt: "2026-09-05T00:00:00.000Z",
        durationMs: plan.side === "baseline" ? times.baselineMs : times.candidateMs,
        userCpuMs: 50,
        systemCpuMs: 10,
        execution,
        exitCode: 0,
      });
    });
}

function inventoryPaths(lane: BenchmarkManifest["lanes"][number]): string[] {
  return [...(lane.config ? [lane.config] : []), ...lane.files];
}

function analyzeRecords(durations: Parameters<typeof recordsFor>[0]) {
  return analyzeBenchmark(recordsFor(durations), manifest);
}

function writeExecutable(file: string, contents: string): void {
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

type ReportAssertion = {
  fullName: string;
  status: "passed" | "skipped";
  location: unknown;
};

function writeSelectedFiles(root: string, files: string[]): void {
  for (const relative of files) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${relative}\n`);
  }
}

function reportAssertion(
  fullName = "suite stable test",
  location: unknown = { line: 62, column: 5 },
  status: ReportAssertion["status"] = "passed",
): ReportAssertion {
  return { fullName, status, location };
}

function reportFixture(id: string, files = ["src/example.test.ts"]) {
  const root = tempDirs.make(`vitest-pair-${id}-`);
  const lane = { id, critical: true, files };
  writeSelectedFiles(root, files);
  return (assertions: ReportAssertion[], success = true, selectedFiles = files) => {
    const file = path.join(root, "report.json");
    const count = assertions.length * selectedFiles.length;
    const countStatus = (status: ReportAssertion["status"]) =>
      success
        ? assertions.filter((entry) => entry.status === status).length * selectedFiles.length
        : 0;
    writeFileSync(
      file,
      JSON.stringify({
        ...execution.counts,
        numTotalTestSuites: selectedFiles.length,
        numPassedTestSuites: success ? selectedFiles.length : 0,
        numFailedTestSuites: success ? 0 : selectedFiles.length,
        numTotalTests: count,
        numPassedTests: countStatus("passed"),
        numFailedTests: success ? 0 : count,
        numPendingTests: countStatus("skipped"),
        success,
        testResults: selectedFiles.map((relative) => ({
          name: path.join(root, relative),
          status: success ? "passed" : "failed",
          assertionResults: assertions,
        })),
      }),
    );
    return parseVitestExecutionReport(file, root, lane);
  };
}

function runScript(
  root: string,
  args: string[],
  options: Partial<Pick<Parameters<typeof runOwnedCommand>[0], "deadline" | "logPath">> = {},
) {
  return runOwnedCommand({
    bin: process.execPath,
    args,
    cwd: root,
    env: { PATH: process.env.PATH },
    logPath: path.join(root, "output.log"),
    timeoutMs: 10_000,
    ...options,
  });
}

function expectTerminalFailure(root: string, error: string) {
  const file = path.join(root, "terminal-manifest.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "failure", error });
}

describe("Vitest pair benchmark", () => {
  it("keeps the committed representative inventory valid and available", () => {
    const committed = loadBenchmarkManifest("scripts/vitest-pair-benchmark-lanes.json");
    expect(assertInventoryAvailable(process.cwd(), committed).inventorySha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("rejects malformed and duplicate inventories", () => {
    const escapeLane = { ...manifest.lanes[0], files: ["../escape.test.ts"] };
    for (const [override, error] of [
      [{ rounds: 6 }, "exactly seven measured rounds"],
      [{ lanes: [...manifest.lanes, manifest.lanes[0]] }, "duplicate benchmark lane id"],
      [{ lanes: [escapeLane, ...manifest.lanes.slice(1)] }, "normalized repository-relative path"],
    ] as const) {
      expect(() => validateBenchmarkManifest({ ...manifest, ...override })).toThrow(error);
    }
  });

  it("rejects selected workload byte mismatches between sides", () => {
    const baselineRoot = tempDirs.make("vitest-pair-baseline-inventory-");
    const candidateRoot = tempDirs.make("vitest-pair-candidate-inventory-");
    for (const root of [baselineRoot, candidateRoot]) {
      writeSelectedFiles(root, manifest.lanes.flatMap(inventoryPaths));
    }
    writeFileSync(path.join(candidateRoot, manifest.lanes[0]!.files[0]!), "changed workload\n");

    expect(() =>
      assertEquivalentInventories(
        assertInventoryAvailable(baselineRoot, manifest),
        assertInventoryAvailable(candidateRoot, manifest),
      ),
    ).toThrow("benchmark workload bytes differ");
  });

  it("requires successful JSON execution reports with the exact selected file set", () => {
    const read = reportFixture("report-files", ["src/first.test.ts", "src/second.test.ts"]);
    expect(() => read([reportAssertion("first test")], true, ["src/first.test.ts"])).toThrow(
      "executed files differ",
    );
    expect(() => read([reportAssertion()], false)).toThrow("did not report success");
  });

  it("uses source locations instead of version-specific rendered names", () => {
    const read = reportFixture("report-digest");
    const baseline = read([
      reportAssertion("maps 'avif'"),
      reportAssertion("maps 'jpg'"),
      reportAssertion("'detects docx'", { line: 79, column: 14 }),
    ]);
    const candidate = read([
      reportAssertion("maps avif"),
      reportAssertion("maps jpg"),
      reportAssertion("detects docx", { line: 79, column: 14 }),
    ]);

    expect(candidate.digest).toBe(baseline.digest);
    expect(candidate.assertionCount).toBe(3);
  });

  it("fails closed when assertion locations are missing or malformed", () => {
    const read = reportFixture("report-location");

    for (const location of [
      undefined,
      { line: 0, column: 5 },
      { line: 62, column: 5.5 },
      { line: 62, column: "5" },
    ] as const) {
      expect(() => read([{ fullName: "suite stable test", status: "passed", location }])).toThrow(
        "location must contain positive integer line and column",
      );
    }
  });

  it("fails closed when assertion status or source location diverges", () => {
    const read = reportFixture("report-divergence");
    const baseline = read([reportAssertion()]);

    for (const [label, assertion] of [
      ["status", reportAssertion("suite stable test", { line: 62, column: 5 }, "skipped")],
      ["location", reportAssertion("suite stable test", { line: 63, column: 5 })],
    ] as const) {
      const candidate = read([assertion]);
      expect(() =>
        assertExecutionDigest(candidate, baseline.digest, `${label} timing run`),
      ).toThrow("execution digest differs");
    }
  });

  it("rotates lane order and alternates paired side order", () => {
    const schedule = buildBenchmarkSchedule(manifest);
    const measured = schedule.filter((entry) => entry.phase === "measured");
    const pairs = (lanes: string[], ...sides: string[]) =>
      lanes.flatMap((lane) => sides.map((side) => `${lane}:${side}`));
    expect(measured.slice(0, 16).map((entry) => `${entry.lane.id}:${entry.side}`)).toStrictEqual([
      ...pairs(["core", "gateway", "ui", "lifecycle"], "baseline", "candidate"),
      ...pairs(["gateway", "ui", "lifecycle", "core"], "candidate", "baseline"),
    ]);
    expect(schedule.filter((entry) => entry.phase === "warmup")).toHaveLength(8);
    expect(schedule.filter((entry) => entry.phase === "cold")).toHaveLength(8);
  });

  it("refuses reruns before a benchmark child can start", () => {
    expect(() => assertSingleWorkflowAttempt("1")).not.toThrow();
    expect(() => assertSingleWorkflowAttempt("2")).toThrow("dispatch a fresh run");
  });

  it("fails critical regressions and avoids noisy improvement claims", () => {
    const regression = analyzeRecords((lane) => ({
      baselineMs: 10_000,
      candidateMs: lane === "gateway" ? 13_000 : 10_000,
    }));
    expect(regression.verdict).toBe("regression");
    expect(regression.regressions).toStrictEqual(
      expect.arrayContaining([expect.stringContaining("gateway median paired wall ratio")]),
    );

    const neutral = analyzeRecords(0.98);
    expect(neutral).toMatchObject({ verdict: "pass", performance: "no-material-change" });
    expect(neutral.claim).toContain("No broad improvement claim");

    expect(analyzeRecords(0.9)).toMatchObject({ verdict: "pass", performance: "improved" });

    const noisyFaster = analyzeRecords((_lane, round) => ({
      baselineMs: 100,
      candidateMs: 100 * (round !== null && round <= 4 ? 0.9 : 0.999),
    }));
    expect(noisyFaster).toMatchObject({ verdict: "pass", performance: "no-material-change" });
    expect(noisyFaster.lanes.every((lane) => lane.candidateImprovedPairs === 4)).toBe(true);
  });

  itUnix("pins pnpm despite poisoned ambient pnpm and Corepack state", () => {
    const root = tempDirs.make("vitest-pair-pnpm-");
    const bin = path.join(root, "bin");
    const marker = path.join(root, "invocations.txt");
    const pinnedDir = path.join(root, "pinned");
    mkdirSync(bin);
    mkdirSync(pinnedDir);
    for (const name of ["pnpm", "corepack"]) {
      writeExecutable(
        path.join(bin, name),
        `#!/bin/sh\nprintf 'poison:${name}\\n' >> ${JSON.stringify(marker)}\nexit 97\n`,
      );
    }
    const pinned = path.join(pinnedDir, "pnpm");
    writeExecutable(
      pinned,
      `#!/bin/sh\n[ "\${pnpm_config_pm_on_fail:-}" = ignore ] || exit 96\nprintf 'pinned\\n' >> ${JSON.stringify(marker)}\nprintf '12.1.0\\n'\n`,
    );
    const ambientEnv = {
      ...process.env,
      COREPACK_HOME: path.join(root, "poison-corepack"),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: path.join(bin, "pnpm"),
    };
    const identity = resolvePackageManagerIdentity(pinned, path.join(root, "probe"), ambientEnv);
    const cacheRoot = path.join(root, "run-cache");
    const env = buildBenchmarkCommandEnv(path.join(root, "home"), cacheRoot, identity, ambientEnv);
    const runner = resolvePnpmRunner({ env, pnpmArgs: ["--version"] });
    const result = spawnSync(runner.command, runner.args, {
      encoding: "utf8",
      env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("12.1.0");
    expect(identity).toStrictEqual({
      executable: pinned,
      resolvedExecutable: pinned,
      version: "12.1.0",
    });
    expect(env.npm_execpath).toBe(pinned);
    expect(env.COREPACK_HOME).toBe(path.join(cacheRoot, "corepack"));
    expect(readFileSync(marker, "utf8")).toBe("pinned\npinned\n");
  });
  it("persists terminal failure and atomically replaces JSON state", async () => {
    const root = tempDirs.make("vitest-pair-terminal-");
    const state = path.join(root, "state.json");
    writeJsonAtomic(state, { generation: 1 });
    writeJsonAtomic(state, { generation: 2 });
    expect(JSON.parse(readFileSync(state, "utf8"))).toStrictEqual({ generation: 2 });

    await expect(
      withTerminalManifest(root, async () => {
        throw new Error("injected benchmark failure");
      }),
    ).rejects.toThrow("injected benchmark failure");
    expectTerminalFailure(root, "injected benchmark failure");
  });

  itUnix(
    "aborts the active child at the aggregate deadline and starts no successor",
    ({ signal }) =>
      deadlineFixtureLifetime.run(async () => {
        const root = deadlineFixtureLifetime.createTempDir("vitest-pair-deadline-");
        const pidFile = path.join(root, "active.pid");
        const successor = path.join(root, "successor.txt");
        const output = path.join(root, "output");
        const observation = await deadlineFixtureLifetime.acquire(async () => {
          const receipts = await openFixtureReceiptChannel();
          return { receipts, cleanup: () => receipts.close() };
        });
        const activeScript = [
          'import { renameSync, writeFileSync } from "node:fs";',
          fixtureReceiptClientSource(observation.receipts.endpoint),
          `writeFileSync(${JSON.stringify(`${pidFile}.next`)}, String(process.pid));`,
          `renameSync(${JSON.stringify(`${pidFile}.next`)}, ${JSON.stringify(pidFile)});`,
          `sendReceipt(${JSON.stringify(pidFile)}, "ready");`,
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const ready = observation.receipts.waitFor(pidFile, "ready");
        // Hold eager expiry and the watchdog until the real child reports readiness.
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
        const commands: Array<ReturnType<typeof runOwnedCommand>> = [];
        const release = startProcessWatchdogFixture(() =>
          withTerminalManifest(output, () =>
            withVitestPairDeadline(async (deadline) => {
              const start = (name: string, args: string[]) => {
                const command = deadlineFixtureLifetime.track(
                  runScript(root, args, {
                    logPath: path.join(root, `${name}.log`),
                    deadline,
                  }),
                );
                commands.push(command);
                return command;
              };
              await Promise.allSettled([
                start("active", ["--input-type=module", "-e", activeScript]),
              ]);
              await Promise.allSettled([
                start("successor", [
                  "-e",
                  `require("node:fs").writeFileSync(${JSON.stringify(successor)}, "started")`,
                ]),
              ]);
            }, 500),
          ),
        );
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              ready,
              commands[0]!,
              "benchmark child exited before readiness",
            ),
            signal,
          );
          clock.mockRestore();
          await expect(release()).rejects.toThrow("Vitest pair aggregate deadline exceeded");

          // Assert outside the deadline owner, which normalizes task errors after cancellation.
          expect(commands).toHaveLength(2);
          await expect(commands[0]).rejects.toMatchObject({
            name: "Error",
            message: "Managed command aborted",
            code: "ABORT_ERR",
          });
          await expect(commands[1]).rejects.toMatchObject({
            name: "Error",
            message: "Vitest pair aggregate deadline exceeded after 500ms",
            code: "ETIMEDOUT",
          });
          expect(isProcessAlive(Number.parseInt(readFileSync(pidFile, "utf8"), 10))).toBe(false);
          expect(existsSync(successor)).toBe(false);
          expectTerminalFailure(output, "Vitest pair aggregate deadline exceeded after 500ms");
        } finally {
          clock.mockRestore();
          await release().catch(() => {});
          await Promise.allSettled(commands);
          await observation.cleanup();
        }
      }),
  );

  itUnix("does not retry a failed benchmark child", async () => {
    const root = tempDirs.make("vitest-pair-no-retry-");
    const attempts = path.join(root, "attempts.txt");
    const script = [
      'const { appendFileSync } = require("node:fs");',
      `appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");`,
      "process.exit(7);",
    ].join("\n");

    const result = await runScript(root, ["-e", script]);

    expect(result.exitCode).toBe(7);
    expect(readFileSync(attempts, "utf8")).toBe("attempt\n");
  });
});
