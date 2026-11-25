import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNodeCacheDiagnostic } from "../../scripts/lib/node-compile-cache-diagnostics.mts";
import {
  inventoryPreparedWorkload,
  preparedInventoryDelta,
} from "../../scripts/lib/prepared-workload-inventory.mts";
import {
  analyzeBenchmark,
  analyzeNodeCacheBenchmark,
  assertEquivalentInventories,
  assertExecutionDigest,
  assertInventoryAvailable,
  assertSingleWorkflowAttempt,
  buildBenchmarkSchedule,
  buildNodeCacheSchedule,
  loadBenchmarkManifest,
  parseVitestExecutionReport,
  sha256,
  validateNodeCacheManifest,
  validateBenchmarkManifest,
  withTerminalManifest,
  writeJsonAtomic,
  type BenchmarkManifest,
  type BenchmarkRunRecord,
  type NodeCacheManifest,
} from "../../scripts/lib/vitest-pair-benchmark-contract.mts";
import {
  buildBenchmarkCommandEnv,
  buildNodeCacheVitestArgs,
  resolvePackageManagerIdentity,
  runOwnedCommand,
  readNodeCacheSeed,
  restoreNodeCacheSeed,
  runNodeCacheBenchmark,
  runQualifiedNodeCacheBenchmark,
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

function reportFixture(
  id: string,
  files = ["src/example.test.ts"],
  expected?: NodeCacheManifest["expected"],
) {
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
    return parseVitestExecutionReport(file, root, lane, expected);
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

function runBenchmarkCli(extraArgs: string[], includeManifest = true) {
  const root = tempDirs.make("vitest-pair-cli-");
  const outputDir = path.join(root, "output");
  const args = [
    "--baseline",
    "baseline",
    "--baseline-sha",
    "a".repeat(40),
    "--candidate",
    path.join(root, "candidate"),
    "--candidate-sha",
    "b".repeat(40),
    "--output",
    outputDir,
    "--pnpm-bin",
    path.join(root, "unused-pnpm"),
    "--run-attempt",
    "2",
    "--scratch",
    path.join(root, "scratch"),
  ];
  if (includeManifest) {
    args.push("--manifest", path.join(root, "unused-manifest.json"));
  }
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/vitest-pair-benchmark.mts"), ...args, ...extraArgs],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        NODE_DISABLE_COMPILE_CACHE: "1",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "bun-cache"),
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  for (const directory of ["baseline", "candidate", "scratch"]) {
    expect(existsSync(path.join(root, directory))).toBe(false);
  }
  return { outputDir, stderr: result.stderr };
}

function cacheManifest(): NodeCacheManifest {
  const runtime = {
    node: "v24.22.1",
    v8: "fixture-v8",
    platform: "linux",
    architecture: "x64",
    executableSha256: "a".repeat(64),
  };
  const inputs: NodeCacheManifest["inputs"] = [
    "src/example.test.ts",
    "vitest.config.ts",
    "scripts/run-vitest.mjs",
  ].map((filePath) => ({ path: filePath, bytes: 1, sha256: "b".repeat(64) }));
  return {
    version: 2,
    mode: "node-compile-cache",
    workloadSha: "d".repeat(40),
    lane: {
      id: "plugin-contract",
      critical: true,
      config: "vitest.config.ts",
      files: ["src/example.test.ts"],
    },
    expected: ["suite case A", "suite case B"].map((fullName) => ({
      file: "src/example.test.ts",
      fullName,
      line: 62,
      column: 5,
      status: "passed",
    })),
    runtime,
    pnpmSha256: "e".repeat(64),
    inputs,
    seed: { files: [{ path: "version/entry", bytes: 1, sha256: "f".repeat(64) }] },
  };
}

describe("Node compile-cache benchmark contract", () => {
  it("uses the same cache opt-outs for configured and file-only lanes", () => {
    const lane = { id: "fixture", critical: true, files: ["case.test.ts"] };
    const report = path.resolve("report.json");
    expect(buildNodeCacheVitestArgs(lane, report)).toEqual([
      "scripts/run-vitest.mjs",
      "case.test.ts",
      "--",
      "--reporter=json",
      "--includeTaskLocation",
      "--outputFile",
      report,
      "--no-cache",
      "--no-fsModuleCache",
    ]);
    expect(buildNodeCacheVitestArgs({ ...lane, config: "vitest.config.ts" }, report)).toEqual([
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "vitest.config.ts",
      "--reporter=json",
      "--includeTaskLocation",
      "--outputFile",
      report,
      "case.test.ts",
      "--no-cache",
      "--no-fsModuleCache",
    ]);
    expect(() => buildNodeCacheVitestArgs(lane, "relative.json")).toThrow("must be absolute");
  });

  itUnix(
    "reports complete ignored-file, mode and internal-link deltas, excluding only root Git metadata",
    async () => {
      const root = realpathSync(tempDirs.make("prepared-inventory-"));
      mkdirSync(path.join(root, ".git"));
      mkdirSync(path.join(root, ".ignored"));
      writeFileSync(path.join(root, ".git", "index"), "metadata");
      writeFileSync(path.join(root, ".gitignore"), ".ignored/\n");
      writeFileSync(path.join(root, ".ignored", "generated"), "before");
      writeFileSync(path.join(root, "removed"), "removed");
      writeFileSync(path.join(root, "mode"), "unchanged bytes");
      chmodSync(path.join(root, "mode"), 0o600);
      symlinkSync("mode", path.join(root, "link"));
      await withVitestPairDeadline(async (deadline) => {
        const before = await inventoryPreparedWorkload(root, deadline);
        writeFileSync(path.join(root, ".git", "index"), "different metadata");
        expect(await inventoryPreparedWorkload(root, deadline)).toEqual(before);
        writeFileSync(path.join(root, ".ignored", "generated"), "after");
        writeFileSync(path.join(root, ".ignored", "added"), "added");
        chmodSync(path.join(root, "mode"), 0o700);
        rmSync(path.join(root, "removed"));
        rmSync(path.join(root, "link"));
        symlinkSync(".ignored/generated", path.join(root, "link"));
        const delta = preparedInventoryDelta(
          before,
          await inventoryPreparedWorkload(root, deadline),
        );
        expect(delta.counts).toEqual({ before: 5, after: 5, added: 1, removed: 1, changed: 3 });
        expect(delta.added).toEqual([
          {
            path: ".ignored/added",
            kind: "file",
            bytes: 5,
            sha256: sha256("added"),
            mode: statSync(path.join(root, ".ignored", "added")).mode & 0o777,
          },
        ]);
        expect(delta.removed.map((entry) => entry.path)).toEqual(["removed"]);
        expect(delta.changed.map((entry) => entry.path)).toEqual([
          ".ignored/generated",
          "link",
          "mode",
        ]);
        expect(delta.beforeSha256).not.toBe(delta.afterSha256);
        rmSync(path.join(root, "link"));
        symlinkSync("missing", path.join(root, "link"));
        await expect(inventoryPreparedWorkload(root, deadline)).rejects.toThrow();
        rmSync(path.join(root, "link"));
        symlinkSync(root + "/..", path.join(root, "link"));
        await expect(inventoryPreparedWorkload(root, deadline)).rejects.toThrow("escapes workload");
        rmSync(path.join(root, "link"));
        symlinkSync(".git/index", path.join(root, "link"));
        await expect(inventoryPreparedWorkload(root, deadline)).rejects.toThrow(
          "excluded Git metadata",
        );
      });
    },
  );

  itUnix("rejects special prepared files without trying to read their contents", async () => {
    const root = realpathSync(tempDirs.make("prepared-special-"));
    const result = spawnSync("mkfifo", [path.join(root, "pipe")], { timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    await withVitestPairDeadline(async (deadline) => {
      await expect(inventoryPreparedWorkload(root, deadline)).rejects.toThrow("special file");
    });
  });

  it("requires the runner, selected inputs and a nonempty expanded expected inventory", () => {
    expect(validateNodeCacheManifest(cacheManifest()).expected).toHaveLength(2);
    const missing = cacheManifest();
    missing.expected = [];
    expect(() => validateNodeCacheManifest(missing)).toThrow("expected passed inventory");
    const runner = cacheManifest();
    runner.inputs = runner.inputs.filter(
      ({ path: filePath }) => filePath !== "scripts/run-vitest.mjs",
    );
    expect(() => validateNodeCacheManifest(runner)).toThrow("lane input identity");
    const escaping = cacheManifest();
    escaping.seed.files[0]!.path = "../other";
    expect(() => validateNodeCacheManifest(escaping)).toThrow("repository-relative");
  });

  it("requires expanded names and multiplicities even when source locations and totals match", () => {
    const expected = cacheManifest().expected;
    const parse = reportFixture("strict-cases", undefined, expected);
    const assertions = expected.map((entry) => reportAssertion(entry.fullName));
    expect(parse(assertions).assertionCount).toBe(2);
    expect(parse(assertions.toReversed()).assertionCount).toBe(2);
    expect(() => parse([assertions[0]!, assertions[0]!])).toThrow("expected passed inventory");
    expect(() => parse([reportAssertion("other case"), assertions[1]!])).toThrow(
      "expected passed inventory",
    );
    expect(() =>
      parse([
        reportAssertion(expected[0]!.fullName, { line: 62, column: 5 }, "skipped"),
        assertions[1]!,
      ]),
    ).toThrow("expected passed inventory");
    expect(() => parse([])).toThrow("expected passed inventory");
    const repeated = reportFixture("strict-duplicates", undefined, [expected[0]!, expected[0]!]);
    expect(repeated([assertions[0]!, assertions[0]!]).assertionCount).toBe(2);
    expect(() => repeated([assertions[0]!])).toThrow("expected passed inventory");
  });

  it("uses twenty balanced ordered pairs and the separate median/count decision", () => {
    const schedule = buildNodeCacheSchedule();
    expect(schedule).toHaveLength(40);
    expect(
      schedule.filter((_, index) => index % 2 === 0 && schedule[index]!.treatment === "disabled"),
    ).toHaveLength(10);
    const records = schedule.map(({ pair, treatment }) => ({
      pair,
      treatment,
      status: "success" as const,
      inclusiveMs: treatment === "disabled" ? 100 : pair <= 15 ? 90 : 110,
    }));
    expect(analyzeNodeCacheBenchmark(records)).toMatchObject({
      medianRatio: 0.9,
      fasterPairs: 15,
      continueScreen: true,
    });
    records.find((record) => record.pair === 15 && record.treatment === "seeded")!.inclusiveMs =
      110;
    expect(analyzeNodeCacheBenchmark(records)).toMatchObject({
      fasterPairs: 14,
      continueScreen: false,
    });
    expect(() => analyzeNodeCacheBenchmark(records.slice(1))).toThrow("complete ordered");
    expect(() => analyzeNodeCacheBenchmark(records.toReversed())).toThrow("complete ordered");
    expect(() =>
      analyzeNodeCacheBenchmark([{ ...records[0]!, inclusiveMs: null }, ...records.slice(1)]),
    ).toThrow("complete ordered");
  });

  itUnix("inventories only regular Node-cache bytes and rejects escaping links", () => {
    const root = tempDirs.make("node-cache-seed-");
    mkdirSync(path.join(root, "version"));
    writeFileSync(path.join(root, "version", "entry"), "compiled");
    expect(readNodeCacheSeed(root)).toEqual([
      { path: "version/entry", bytes: 8, sha256: sha256("compiled") },
    ]);
    symlinkSync(path.join(root, "version", "entry"), path.join(root, "link"));
    expect(() => readNodeCacheSeed(root)).toThrow("only regular");
  });

  itUnix("restores a writable disposable copy without changing a read-only seed", () => {
    const root = tempDirs.make("node-cache-restore-");
    const seed = path.join(root, "seed");
    const active = path.join(root, "active");
    mkdirSync(seed);
    writeFileSync(path.join(seed, "entry"), "compiled");
    chmodSync(path.join(seed, "entry"), 0o444);
    chmodSync(seed, 0o555);
    const before = readNodeCacheSeed(seed);
    try {
      restoreNodeCacheSeed(seed, active);
      expect(readNodeCacheSeed(active)).toEqual(before);
      writeFileSync(path.join(active, "entry"), "new compilation");
      expect(readNodeCacheSeed(seed)).toEqual(before);
      expect(statSync(seed).mode & 0o777).toBe(0o555);
      expect(statSync(path.join(seed, "entry")).mode & 0o777).toBe(0o444);
      expect(() => restoreNodeCacheSeed(seed, active)).toThrow();
    } finally {
      chmodSync(seed, 0o700);
      chmodSync(path.join(seed, "entry"), 0o600);
    }
  });

  itUnix.each(["disabled", "seeded"] as const)(
    "propagates isolated %s treatment through an actual child",
    async (kind) => {
      const root = tempDirs.make("node-cache-env-");
      const env = buildBenchmarkCommandEnv(
        path.join(root, "home"),
        path.join(root, "state"),
        packageManager,
        {
          PATH: process.env.PATH,
          NODE_DISABLE_COMPILE_CACHE: "poison",
          OPENCLAW_VITEST_RUNTIME: "bun",
          TSX_DISABLE_CACHE: "poison",
          NODE_OPTIONS: "--bad-option",
          NODE_DEBUG_NATIVE: "COMPILE_CACHE",
          COREPACK_ENABLE_NETWORK: "1",
          npm_config_offline: "false",
          pnpm_config_manage_package_manager_versions: "true",
        },
        { kind, nodeCache: path.join(root, "active-node") },
      );
      const keys = [
        "PATH",
        "COREPACK_ENABLE_NETWORK",
        "npm_config_offline",
        "pnpm_config_manage_package_manager_versions",
        "NODE_DISABLE_COMPILE_CACHE",
        "NODE_COMPILE_CACHE",
        "OPENCLAW_VITEST_RUNTIME",
        "OPENCLAW_VITEST_FS_MODULE_CACHE",
        "OPENCLAW_VITEST_WORKER_CACHE",
        "TSX_DISABLE_CACHE",
        "OPENCLAW_VITEST_MAX_WORKERS",
        "NODE_OPTIONS",
        "NODE_DEBUG_NATIVE",
      ];
      await runOwnedCommand({
        bin: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))))`,
        ],
        cwd: root,
        env,
        logPath: path.join(root, "env.json"),
        timeoutMs: 10_000,
      });
      expect(JSON.parse(readFileSync(path.join(root, "env.json"), "utf8"))).toEqual({
        PATH: [
          path.dirname(packageManager.executable),
          path.dirname(process.execPath),
          process.env.PATH,
        ]
          .filter(Boolean)
          .join(path.delimiter),
        COREPACK_ENABLE_NETWORK: "0",
        npm_config_offline: "true",
        pnpm_config_manage_package_manager_versions: "false",
        NODE_DISABLE_COMPILE_CACHE: kind === "disabled" ? "1" : null,
        NODE_COMPILE_CACHE: path.join(root, "active-node"),
        OPENCLAW_VITEST_RUNTIME: "node",
        OPENCLAW_VITEST_FS_MODULE_CACHE: "0",
        OPENCLAW_VITEST_WORKER_CACHE: "0",
        TSX_DISABLE_CACHE: null,
        OPENCLAW_VITEST_MAX_WORKERS: "1",
        NODE_OPTIONS: null,
        NODE_DEBUG_NATIVE: null,
      });
    },
  );

  it.each([
    [["--mode", "node-compile-cache"], "--baseline is not supported"],
    [["--workload", "prepared"], "--workload and --seed require"],
    [["--seed", "sealed"], "--workload and --seed require"],
    [["--qualification", "proof"], "--qualification requires"],
    [["--mode", "node-cache-qualified-measurement"], "--baseline is not supported"],
  ])("rejects mixed CLI mode arguments before output", (args, error) => {
    const { outputDir, stderr } = runBenchmarkCli(args);
    expect(stderr).toContain(error);
    expect(existsSync(outputDir)).toBe(false);
  });
});

describe("native Node cache evidence", () => {
  const source = "file:///work/entry.mjs";
  const cache = "/work/cache";
  const hit = `[compile cache] reading cache from ${cache}/version/12345678 for ESM ${source}...[1 20 40 50 60]... success, size=40\n`;
  const accepted = `[compile cache] V8 code cache for ESM ${source} was accepted, keeping the in-memory entry\n`;
  const missing = `[compile cache] reading cache from ${cache}/version/12345678 for ESM ${source}... no such file or directory\n`;
  const generated = `[compile cache] V8 code cache for ESM ${source} was not initialized, initializing the in-memory entry\n`;

  it("distinguishes a disk read from V8 acceptance and first generation", () => {
    expect(parseNodeCacheDiagnostic(hit + accepted, source, cache)).toMatchObject({
      read: "hit",
      state: "accepted",
      cacheFile: "version/12345678",
    });
    expect(parseNodeCacheDiagnostic(missing + generated, source, cache)).toMatchObject({
      read: "missing",
      state: "not initialized",
    });
    expect(parseNodeCacheDiagnostic("", source, cache)).toBeNull();
  });

  it.each([
    [hit, "one ordered"],
    [accepted + hit, "one ordered"],
    [hit + accepted + accepted, "one ordered"],
    [hit + accepted.replace("entry\n", "ent"), "Incomplete or interleaved"],
    [hit + accepted.trimEnd(), "Incomplete or interleaved"],
    [
      hit + accepted + "[compile cache] V8 code cache for ESM file:///work/entry.\n",
      "Incomplete or interleaved",
    ],
    [
      hit +
        accepted +
        "[compile cache] reading cache from /work/cache/key for ESM file:///work/entry.\n",
      "Incomplete or interleaved",
    ],
    [hit + accepted.replace("accepted,", "accepted, [compile cache]"), "Incomplete or interleaved"],
    [hit + accepted.replace("ESM", "CommonJS"), "Incomplete or interleaved"],
    [missing + accepted, "disagree"],
    [hit.replace("success, size=40", "success, size=") + accepted, "Incomplete or interleaved"],
    [
      hit.replace(" success, size=40", "code hash mismatch: expected 1") + generated,
      "Incomplete or interleaved",
    ],
    [
      hit.replace(
        " success, size=40",
        "code hash mismatch: expected 1, actual 2 [compile cache] interleaved",
      ) + generated,
      "Incomplete or interleaved",
    ],
    [hit.replace(`${cache}/version`, "/elsewhere/version") + accepted, "escapes"],
  ])("rejects incomplete or contradictory native evidence %#", (log, message) => {
    expect(() => parseNodeCacheDiagnostic(log, source, cache)).toThrow(message);
  });

  it("keeps V8 rejection distinct from source invalidation", () => {
    expect(
      parseNodeCacheDiagnostic(
        hit + accepted.replace("accepted, keeping", "rejected, refreshing"),
        source,
        cache,
      ),
    ).toMatchObject({ read: "hit", state: "rejected" });
    expect(
      parseNodeCacheDiagnostic(
        hit.replace(" success, size=40", "code hash mismatch: expected 1, actual 2") + generated,
        source,
        cache,
      ),
    ).toMatchObject({ read: "invalid", state: "not initialized" });
  });
});

itUnix("records failed qualification admission without starting a measured child", async () => {
  const root = realpathSync(tempDirs.make("node-cache-admission-"));
  const workloadDir = path.join(root, "workload");
  const qualificationDir = path.join(root, "qualification");
  const outputDir = path.join(root, "output");
  const scratchDir = path.join(root, "scratch");
  mkdirSync(workloadDir);
  mkdirSync(qualificationDir);
  let attempts = 0;
  await expect(
    runQualifiedNodeCacheBenchmark({
      workloadDir,
      qualificationDir,
      outputDir,
      scratchDir,
      pnpmBin: process.execPath,
      timeoutMs: 10_000,
      admit: () => {
        attempts += 1;
        throw new Error("qualification receipt changed");
      },
    }),
  ).rejects.toThrow("qualification receipt changed");
  expect(attempts).toBe(1);
  expect(
    JSON.parse(readFileSync(path.join(outputDir, "terminal-manifest.json"), "utf8")),
  ).toMatchObject({
    status: "failure",
    error: "qualification receipt changed",
  });
  expect(readdirSync(outputDir)).toEqual(["terminal-manifest.json"]);
  expect(existsSync(scratchDir)).toBe(false);
});

it.runIf(process.platform === "linux" && process.version === "v24.22.1" && !process.versions.bun)(
  "qualifies native cache diagnostics through the real CLI and Node runtime",
  async () => {
    const root = realpathSync(tempDirs.make("node-cache-diagnostics-"));
    const output = path.join(root, "output");
    const result = await runOwnedCommand({
      bin: process.execPath,
      args: [
        path.resolve("scripts/vitest-pair-benchmark.mts"),
        "--mode",
        "node-cache-diagnostics",
        "--output",
        output,
        "--run-attempt",
        "1",
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: root },
      logPath: path.join(root, "cli.log"),
      timeoutMs: 30_000,
    });
    expect(result.exitCode, readFileSync(path.join(root, "cli.log"), "utf8")).toBe(0);
    const receipt = JSON.parse(readFileSync(path.join(output, "diagnostics.json"), "utf8"));
    expect(
      receipt.controls.map((control: { kind: string; observation: { state: string } | null }) => [
        control.kind,
        control.observation?.state ?? null,
      ]),
    ).toEqual([
      ["disabled", null],
      ["empty", "not initialized"],
      ["seeded", "accepted"],
      ["invalidated", "not initialized"],
    ]);
    expect(
      JSON.parse(readFileSync(path.join(output, "terminal-manifest.json"), "utf8")).status,
    ).toBe("success");
    expect(existsSync(path.join(output, "scratch"))).toBe(false);
  },
  40_000,
);

// The production case requires GNU time and the pinned runtime. macOS/Bun helper
// controls above do not substitute for this Linux execution proof.
it.runIf(process.platform === "linux" && process.version === "v24.22.1" && !process.versions.bun)(
  "measures prepared Node-cache pairs with inclusive cleanup and preserves failed cases",
  async () => {
    const root = realpathSync(tempDirs.make("node-cache-lifecycle-"));
    const workload = path.join(root, "workload");
    const seed = path.join(root, "seed");
    const scratch = path.join(root, "scratch");
    const active = path.join(scratch, "active");
    mkdirSync(workload);
    mkdirSync(path.join(workload, "scripts"));
    const nodeCacheManifest = cacheManifest();
    nodeCacheManifest.lane = {
      id: "fixture",
      critical: true,
      config: "vitest.config.ts",
      files: ["case.test.ts"],
    };
    nodeCacheManifest.expected = nodeCacheManifest.expected.map((entry) => ({
      ...entry,
      file: "case.test.ts",
    }));
    const report = {
      ...execution.counts,
      numTotalTests: 2,
      numPassedTests: 2,
      success: true,
      testResults: [
        {
          name: path.join(workload, "case.test.ts"),
          status: "passed",
          assertionResults: nodeCacheManifest.expected.map(
            ({ fullName, line, column, status }) => ({
              fullName,
              status,
              location: { line, column },
            }),
          ),
        },
      ],
    };
    const script = [
      'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
      'import assert from "node:assert/strict";',
      'for (const [key, value] of Object.entries({ CI: "1", COREPACK_ENABLE_NETWORK: "0", npm_config_offline: "true", pnpm_config_manage_package_manager_versions: "false", OPENCLAW_VITEST_RUNTIME: "node", OPENCLAW_VITEST_MAX_WORKERS: "1", OPENCLAW_VITEST_FS_MODULE_CACHE: "0", OPENCLAW_VITEST_WORKER_CACHE: "0" })) assert.equal(process.env[key], value);',
      "assert.equal(process.env.TSX_DISABLE_CACHE, undefined);",
      'assert.ok(process.argv.includes("--no-cache"));',
      'assert.ok(process.argv.includes("--no-fsModuleCache"));',
      'if (existsSync("../mutate")) { mkdirSync(".ignored", { recursive: true }); writeFileSync(".ignored/generated", "mutation"); }',
      `writeFileSync(process.argv[process.argv.indexOf("--outputFile") + 1], JSON.stringify(${JSON.stringify(report)}));`,
      "console.log(JSON.stringify({ active: process.env.NODE_COMPILE_CACHE, disabled: process.env.NODE_DISABLE_COMPILE_CACHE ?? null }));",
    ].join("\n");
    const sources = {
      "scripts/run-vitest.mjs": script,
      "case.test.ts": "fixture",
      "vitest.config.ts": "fixture",
    };
    nodeCacheManifest.inputs = Object.entries(sources).map(([relative, bytes]) => {
      writeFileSync(path.join(workload, relative), bytes);
      return { path: relative, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
    });
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: workload, encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    writeFileSync(path.join(workload, ".gitignore"), ".ignored/\n");
    git(["init", "-q"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    ]);
    nodeCacheManifest.workloadSha = git(["rev-parse", "HEAD"]);
    nodeCacheManifest.runtime = {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      executableSha256: sha256(readFileSync(process.execPath)),
    };
    nodeCacheManifest.pnpmSha256 = nodeCacheManifest.runtime.executableSha256;
    // Fixture preparation is external to the controller and its timed boundary.
    const env = buildBenchmarkCommandEnv(
      path.join(active, "home"),
      path.join(active, "state"),
      { executable: process.execPath, resolvedExecutable: process.execPath, version: "fixture" },
      process.env,
      { kind: "seeded", nodeCache: path.join(active, "node-compile") },
    );
    const seeded = spawnSync(
      process.execPath,
      buildNodeCacheVitestArgs(nodeCacheManifest.lane, path.join(root, "seed-report.json")),
      { cwd: workload, env, encoding: "utf8", timeout: 10_000 },
    );
    expect(seeded.error).toBeUndefined();
    expect(seeded.signal).toBeNull();
    expect(seeded.status, seeded.stderr).toBe(0);
    renameSync(path.join(active, "node-compile"), seed);
    rmSync(scratch, { recursive: true });
    nodeCacheManifest.seed = { files: readNodeCacheSeed(seed) };
    validateNodeCacheManifest(nodeCacheManifest);
    const context = {
      workloadDir: workload,
      seedDir: seed,
      manifest: nodeCacheManifest,
      pnpmBin: process.execPath,
      outputDir: path.join(root, "output"),
      scratchDir: scratch,
    };
    const unlisted = path.join(workload, "unlisted.txt");
    writeFileSync(unlisted, "untracked input");
    await expect(runNodeCacheBenchmark(context)).rejects.toThrow(
      "clean tracked and untracked state",
    );
    expect(existsSync(context.outputDir)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    rmSync(unlisted);
    await runNodeCacheBenchmark(context);
    expect(
      JSON.parse(readFileSync(path.join(context.outputDir, "terminal-manifest.json"), "utf8")),
    ).toMatchObject({ status: "success" });
    expect(
      JSON.parse(readFileSync(path.join(context.outputDir, "analysis.json"), "utf8")),
    ).toMatchObject({ valid: true });
    expect(existsSync(scratch)).toBe(false);
    const integrity = JSON.parse(
      readFileSync(path.join(context.outputDir, "prepared-integrity.json"), "utf8"),
    );
    expect(integrity.status).toBe("unchanged");
    expect(integrity.beforeSha256).toBe(integrity.afterSha256);
    expect(integrity.counts).toMatchObject({ added: 0, removed: 0, changed: 0 });
    for (const planned of buildNodeCacheSchedule()) {
      const id = `pair-${planned.pair}-${planned.treatment}`;
      const record = JSON.parse(readFileSync(path.join(context.outputDir, `${id}.json`), "utf8"));
      expect(record).toMatchObject({
        ...planned,
        status: "success",
        cleanup: "removed-owned-active",
        processTreeSettled: true,
        launchEnv: { NODE_COMPILE_CACHE: path.join(scratch, "active/node-compile") },
      });
      expect(record).not.toHaveProperty("env");
      expect(record.inclusiveMs).toBeGreaterThan(0);
      expect(Object.values(record.phases).every((value) => typeof value === "number")).toBe(true);
      expect(
        JSON.parse(readFileSync(path.join(context.outputDir, id, "command.log"), "utf8")),
      ).toEqual({
        active: path.join(scratch, "active/node-compile"),
        disabled: planned.treatment === "disabled" ? "1" : null,
      });
    }
    const terminal = readFileSync(path.join(context.outputDir, "terminal-manifest.json"), "utf8");
    await expect(runNodeCacheBenchmark(context)).rejects.toThrow();
    expect(readFileSync(path.join(context.outputDir, "terminal-manifest.json"), "utf8")).toBe(
      terminal,
    );
    // The reader has its own receipt tests; exercise the qualified runner's
    // output/deadline handoff with this already-prepared process fixture.
    const qualificationDir = path.join(root, "qualification");
    mkdirSync(qualificationDir);
    cpSync(seed, path.join(qualificationDir, "seed"), { recursive: true });
    const qualifiedOutput = path.join(root, "qualified");
    await runQualifiedNodeCacheBenchmark({
      workloadDir: workload,
      qualificationDir,
      outputDir: qualifiedOutput,
      scratchDir: scratch,
      pnpmBin: process.execPath,
      timeoutMs: 30_000,
      admit: () => ({
        manifest: nodeCacheManifest,
        preparedSha256: integrity.beforeSha256 as string,
        provenance: { fixture: true },
        revalidate: () => {},
      }),
    });
    expect(
      JSON.parse(readFileSync(path.join(qualifiedOutput, "terminal-manifest.json"), "utf8")),
    ).toMatchObject({ status: "success" });
    expect(
      JSON.parse(readFileSync(path.join(qualifiedOutput, "qualification.json"), "utf8")),
    ).toEqual({ fixture: true });
    expect(
      JSON.parse(readFileSync(path.join(qualifiedOutput, "analysis.json"), "utf8")),
    ).toMatchObject({ valid: true });
    expect(
      readdirSync(qualifiedOutput).filter((file) =>
        /^pair-\d+-(disabled|seeded)\.json$/u.test(file),
      ),
    ).toHaveLength(40);
    expect(existsSync(scratch)).toBe(false);
    writeFileSync(path.join(root, "mutate"), "enable ignored-file mutation");
    const mutated = {
      ...context,
      outputDir: path.join(root, "mutated"),
      scratchDir: path.join(root, "mutated-scratch"),
    };
    await expect(runNodeCacheBenchmark(mutated)).rejects.toThrow("Prepared workload changed");
    expect(existsSync(path.join(mutated.outputDir, "analysis.json"))).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(mutated.outputDir, "terminal-manifest.json"), "utf8")),
    ).toMatchObject({ status: "failure" });
    const delta = JSON.parse(
      readFileSync(path.join(mutated.outputDir, "prepared-integrity.json"), "utf8"),
    );
    expect(delta).toMatchObject({
      status: "changed",
      counts: { added: 1, removed: 0, changed: 0 },
      added: [{ path: ".ignored/generated", kind: "file", bytes: 8, sha256: sha256("mutation") }],
    });
    expect(delta.beforeSha256).not.toBe(delta.afterSha256);
    expect(
      JSON.parse(readFileSync(path.join(mutated.outputDir, "pair-20-disabled.json"), "utf8")),
    ).toMatchObject({ status: "success", processTreeSettled: true });
    expect(existsSync(path.join(mutated.scratchDir, "active"))).toBe(false);
    rmSync(path.join(root, "mutate"));
    rmSync(path.join(workload, ".ignored"), { recursive: true });
    nodeCacheManifest.expected[0]!.fullName = "missing expected case";
    const failed = { ...context, outputDir: path.join(root, "failed") };
    await expect(runNodeCacheBenchmark(failed)).rejects.toThrow("expected passed inventory");
    expect(
      JSON.parse(readFileSync(path.join(failed.outputDir, "pair-1-disabled.json"), "utf8")),
    ).toMatchObject({
      status: "failure",
      cleanup: "removed-owned-active",
      processTreeSettled: true,
    });
    expect(existsSync(path.join(scratch, "active"))).toBe(false);
    expect(existsSync(path.join(failed.outputDir, "pair-1-seeded.json"))).toBe(false);
    expect(readNodeCacheSeed(seed)).toEqual(nodeCacheManifest.seed.files);
  },
  60_000,
);

describe("Vitest pair benchmark", () => {
  it.each([
    ["--mode", "seeded", "unknown benchmark mode: seeded"],
    ["--baseline", "baseline", "duplicate option --baseline"],
    ["--manifest", "duplicate", "duplicate option --manifest"],
  ])("rejects CLI option %s before creating output", (option, value, error) => {
    const { outputDir, stderr } = runBenchmarkCli([option, value]);
    expect(stderr).toContain(error);
    expect(existsSync(outputDir)).toBe(false);
  });

  it.each([true, false])("accepts legacy CLI options with manifest=%s", (includeManifest) => {
    const { outputDir, stderr } = runBenchmarkCli([], includeManifest);
    const error = "vitest-pair benchmark refuses workflow reruns; dispatch a fresh run";
    expect(stderr).toContain(error);
    expectTerminalFailure(outputDir, error);
  });

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
    expect(env.PATH).toBe(ambientEnv.PATH);
    expect(env.COREPACK_ENABLE_NETWORK).toBeUndefined();
    expect(env.npm_config_offline).toBeUndefined();
    expect(env.pnpm_config_manage_package_manager_versions).toBeUndefined();
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
