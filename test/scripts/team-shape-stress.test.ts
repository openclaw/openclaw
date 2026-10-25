import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  compareStressRuns,
  summarizeStressRun,
  type StressRun,
} from "../../scripts/perf/team-shape-stress-report.ts";
import { parseStressOptions } from "../../scripts/perf/team-shape-stress.ts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const executeFile = promisify(execFile);

it("loads each built entry's own package exports despite controller source aliases", async () => {
  const root = temporary.make("team-stress-build-roots-");
  fs.writeFileSync(path.join(root, "source.mjs"), 'export default "controller-source";');
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "stress-package": ["./source.mjs"] } } }),
  );
  const loader = new URL("../../scripts/perf/team-shape-stress-loader.mjs", import.meta.url);
  for (const side of ["base", "candidate"]) {
    const build = path.join(root, side);
    const pkg = path.join(build, "node_modules", "stress-package");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ type: "module", exports: "./compiled.mjs" }),
    );
    fs.writeFileSync(path.join(pkg, "compiled.mjs"), `export default ${JSON.stringify(side)};`);
    const entry = path.join(build, "entry.mjs");
    fs.writeFileSync(entry, 'import owner from "stress-package"; console.log(owner);');
    const { stdout } = await executeFile(
      resolveTestNodeExecPath(),
      ["--import", loader.href, entry],
      {
        cwd: root,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json") },
        timeout: 15_000,
      },
    );
    expect(stdout.trim()).toBe(side);
  }
});

it("requires ten-minute evidence windows and marks explicit short runs as smoke", () => {
  const options = parseStressOptions(["--output", "/unused"]);
  expect(options).toMatchObject({
    durationMs: 600_000,
    smoke: false,
    clients: 65,
    pairs: 2,
    pollMs: 25_000,
    listWeight: 16,
    roundMs: 60_000,
    churnMs: 6_000,
  });
  expect(parseStressOptions(["--output", "/unused", "--smoke-seconds", "1"])).toMatchObject({
    durationMs: 1_000,
    smoke: true,
  });
  for (const args of [
    [],
    ["--output"],
    ["--output", "/unused", "--unknown"],
    ["--output", "/unused", "--minutes", "9"],
    ["--output", "/unused", "--minutes", "10.5"],
    ["--output", "/unused", "--minutes", "Infinity"],
    ["--output", "/unused", "--clients", "1"],
    ["--output", "/unused", "--runs", "0"],
    ["--output", "/unused", "--plugins", "3"],
    ["--output", "/unused", "--plugins", "41"],
    ["--output", "/unused", "--list-weight", "0"],
    ["--output", "/unused", "--list-weight", "65"],
    ["--output", "/unused", "--pairs", "0"],
    ["--output", "/unused", "--mode", "invalid"],
    ["--output", "/unused", "--port", "18789"],
    ["--output", "/unused", "--port", "65536"],
  ]) {
    expect(() => parseStressOptions(args), JSON.stringify(args)).toThrow();
  }
});

it("records real main-isolate timing windows and settles telemetry once", async () => {
  const output = temporary.make("team-stress-telemetry-");
  const telemetryModule = new URL(
    "../../scripts/perf/team-shape-stress-telemetry.ts",
    import.meta.url,
  );
  await executeFile(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "--eval",
      `import { setTimeout as delay } from 'node:timers/promises';
       const { startTeamStressTelemetry } = await import(${JSON.stringify(telemetryModule.href)});
       const stop = await startTeamStressTelemetry({output: ${JSON.stringify(output)}, allocations: false, intervalMs: 100});
       await delay(250);
       await Promise.all([stop(), stop()]);`,
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 15_000 },
  );
  const summary = JSON.parse(fs.readFileSync(path.join(output, "stress-telemetry.json"), "utf8"));
  const windows = fs
    .readFileSync(path.join(output, "stress-minutes.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(summary).toMatchObject({ mode: "untraced-timing", sampledAllocatedBytes: null });
  expect(summary.pid).not.toBe(process.pid);
  expect(summary.durationMs).toBeGreaterThanOrEqual(200);
  expect(summary.eventLoop.count).toBeGreaterThan(0);
  expect(summary.mainThreadCpuMs).toBeGreaterThanOrEqual(0);
  expect(summary.lastSample.memory.heapUsed).toBeGreaterThan(0);
  expect(summary.lastSample.memory.rss).toBeGreaterThan(0);
  expect(summary.windows).toBe(windows.length);
  expect(windows.filter((window) => window.partial)).toHaveLength(1);
  expect(windows.at(-1).partial).toBe(true);
  expect(windows.every((window) => window.sampledAllocatedBytes === null)).toBe(true);
  expect(fs.existsSync(path.join(output, "stress-allocation.heapprofile"))).toBe(false);
});

it("compares matched pairs in swapped launch order without averaging tiny-base percentages", () => {
  const run = (side: StressRun["side"], pair: number, cpu: number): StressRun => ({
    resultDir: "/synthetic",
    side,
    pair,
    mode: "timing",
    smoke: false,
    durationMs: 600_000,
    metrics: { mainThreadCpuPercent: cpu, zeroCost: 0, missingCost: null },
    rpc: {},
    gc: {},
    stalls: { count: 0, totalMs: 0, maxMs: 0 },
    workerHeaps: undefined,
    rpcMinutes: [],
    nativeOldGenerationSamples: [],
    memoryScope: "synthetic comparison fixture",
  });
  const rows = compareStressRuns([
    run("base", 1, 1),
    run("candidate", 1, 3),
    run("candidate", 2, 80),
    run("base", 2, 100),
  ]);
  const cpu = rows.find((row) => row.metric === "mainThreadCpuPercent");
  expect(cpu).toMatchObject({
    base: 50.5,
    candidate: 41.5,
    absolute: -9,
    pairs: 2,
    pairedDeltas: [2, -20],
  });
  expect(cpu?.percent).toBeCloseTo((-9 / 50.5) * 100);
  expect(rows.find((row) => row.metric === "zeroCost")).toMatchObject({
    base: 0,
    absolute: 0,
    percent: null,
  });
  expect(rows.find((row) => row.metric === "missingCost")).toMatchObject({
    base: null,
    candidate: null,
    absolute: null,
    percent: null,
    pairs: 0,
    context: "inconclusive: missing paired metric",
  });
});

it("keeps partial worker evidence without comparing incomplete heap totals", () => {
  const capture = (side: StressRun["side"], reason?: string) => {
    const resultDir = temporary.make("team-stress-worker-census-");
    const workerMemoryMissing = reason ? [{ script: "fixture-worker", threadId: 2, reason }] : [];
    const workers = {
      workerCount: 2,
      workerHeapSampledCount: reason ? 1 : 2,
      workerHeapUsedBytes: (reason ? 1 : 10) * 1024 ** 2,
      workerArrayBuffersSampledCount: 1,
      workerMemoryCoverage: "partial",
      workerMemoryMissing,
    };
    fs.writeFileSync(
      path.join(resultDir, "result.json"),
      JSON.stringify({
        completedTurns: 1,
        teamStress: { committedWrites: 1, prometheusScrapes: 1, rpcMinutes: [] },
        memorySamples: [{ collectedGarbage: false, resources: { workers } }],
        samples: [
          {
            toolCalls: 1,
            toolResults: 1,
            rpc: Object.fromEntries(
              [
                "sessions.list",
                "chat.history",
                "chat.startup",
                "sessions.diff",
                "connect",
                "chat.inject",
              ].map((method) => [method, { latenciesMs: [1] }]),
            ),
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(resultDir, "stress-telemetry.json"),
      JSON.stringify({
        mode: "untraced-timing",
        durationMs: 600_000,
        mainThreadCpuPercent: 1,
        sampledAllocatedBytesPerSecond: null,
        gc: {},
        eventLoop: { count: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 },
        stalls: { count: 0, totalMs: 0, maxMs: 0 },
        lastSample: { memory: { rss: 1024 ** 2, heapUsed: 1024 ** 2 } },
      }),
    );
    return summarizeStressRun({ resultDir, side, pair: 1, mode: "timing", smoke: false });
  };
  const base = capture("base");
  expect(base.metrics.workerHeapMiB).toBe(10);
  for (const reason of ["pending", "stale", "unavailable"]) {
    const candidate = capture("candidate", reason);
    expect(candidate.workerHeaps?.workerHeapUsedBytes).toBe(1024 ** 2);
    expect(candidate.metrics.workerMemoryMissing).toBe(1);
    expect(candidate.metrics.workerHeapMiB).toBeNull();
    expect(
      compareStressRuns([base, candidate]).find((row) => row.metric === "workerHeapMiB"),
    ).toMatchObject({
      absolute: null,
      percent: null,
      pairs: 0,
      context: "inconclusive: missing paired metric",
    });
  }
});
