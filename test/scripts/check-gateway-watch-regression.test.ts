import { ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  appendBoundedWatchLog,
  buildTimedWatchCommand,
  calculateDistRuntimeByteGrowth,
  collectGatewayWatchFindings,
  hasGatewayReadyLog,
  parseArgs,
  runTimedWatch,
  shouldReportDuplicateDistRuntimeRegression,
  shouldRefreshBuildStampForRestoredArtifacts,
  updateWatchBuildDetection,
  writeBuildAndRuntimePostBuildStamps,
} from "../../scripts/check-gateway-watch-regression.mts";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mts";
import { refreshLocalBuildStampTimes } from "../../scripts/lib/local-build-metadata.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(), spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>();
  return { ...actual, runManagedCommand: vi.fn(actual.runManagedCommand) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

class WatchChildProcess extends ChildProcess {
  override readonly stdout = new PassThrough();
  override readonly stderr = new PassThrough();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  vi.mocked(spawnSync).mockReset();
  vi.mocked(runManagedCommand).mockReset();
});

function createWatchChildFixture(outputDir = tempDirs.make("openclaw-gateway-watch-")) {
  const exitState: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  };
  const child = new WatchChildProcess();
  Object.defineProperties(child, {
    pid: { configurable: true, value: 1234 },
    exitCode: { get: () => exitState.code },
    signalCode: { get: () => exitState.signal },
    stdio: { get: () => [child.stdin, child.stdout, child.stderr, null] },
  });
  const close = () => {
    if (
      child.stdout.closed &&
      child.stderr.closed &&
      (child.exitCode !== null || child.signalCode !== null)
    ) {
      child.emit("close", child.exitCode, child.signalCode);
    }
  };
  child.stdout.once("close", close);
  child.stderr.once("close", close);
  const finish = (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    exitState.code = code;
    exitState.signal = signal;
    child.emit("exit", code, signal);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const onSignal = vi.fn((_signal: Parameters<typeof process.kill>[1]) => finish());
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (Math.abs(pid) !== 1234) {
      throw new Error(`Unexpected fixture process target: ${pid}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw Object.assign(new Error("fixture process exited"), { code: "ESRCH" });
    }
    if (signal !== 0) {
      onSignal(signal);
    }
    return true;
  });
  const spawnChild = vi.mocked(spawn).mockImplementationOnce(() => {
    fs.writeFileSync(path.join(outputDir, "watch.pid"), "1234\n");
    fs.writeFileSync(
      path.join(outputDir, "watch.time.log"),
      "real 0.1\nuser 0\nsys 0\n__TIMING__ user=0 sys=0 elapsed=0.1\n",
    );
    queueMicrotask(() => child.stdout.write("[gateway] ready (0 plugins, 0.1s)\n"));
    return child;
  });
  return { child, finish, onSignal, spawnChild, outputDir };
}

type FindingsInput = Parameters<typeof collectGatewayWatchFindings>[0];
function findings(
  overrides: Partial<Omit<FindingsInput, "watchResult">> & {
    watchResult?: Partial<FindingsInput["watchResult"]>;
  },
) {
  const { watchResult, ...rest } = overrides;
  return collectGatewayWatchFindings({
    distRuntimeByteGrowth: 0,
    distRuntimeFileGrowth: 0,
    removedPaths: 0,
    options: parseArgs([]),
    watchBuildReason: null,
    watchTriggeredBuild: false,
    ...rest,
    watchResult: {
      idleCpuMs: 0,
      readyBeforeWindow: true,
      spawnError: null,
      timingFileMissing: false,
      ...watchResult,
    },
  });
}

function expectHome(outputDir: string, retained: boolean) {
  const home = fs.readFileSync(path.join(outputDir, "watch.home.txt"), "utf8").trim();
  expect(fs.existsSync(home)).toBe(retained);
}

function expectStopped(child: WatchChildProcess) {
  expect(child).toMatchObject({ exitCode: 0, stdout: { closed: true }, stderr: { closed: true } });
}

function observedSleep(before: () => void = () => {}, settleMs = 50) {
  let settled = false;
  const sleep = vi.fn(async (ms: number, signal: AbortSignal) => {
    before();
    try {
      await delay(ms, undefined, { signal });
    } finally {
      await delay(settleMs);
      settled = true;
    }
  });
  return { sleep, expectSettled: () => expect(settled).toBe(true) };
}

function runWatch(
  outputDir: string,
  options: Partial<Parameters<typeof runTimedWatch>[0]>,
  deps: Parameters<typeof runTimedWatch>[2] = {},
) {
  return runTimedWatch(
    { readySettleMs: 0, readyTimeoutMs: 30_000, sigkillGraceMs: 1, windowMs: 10_000, ...options },
    outputDir,
    {
      allocateLoopbackPort: async () => 19042,
      ...deps,
    },
  );
}

function expectExit(
  result: Awaited<ReturnType<typeof runTimedWatch>>,
  code: number,
  ready: boolean,
) {
  expect(result.exit).toEqual({ code, signal: null });
  expect(result).toMatchObject({
    exitedBeforeReady: !ready,
    exitedBeforeStop: true,
    readyBeforeWindow: ready,
  });
}

it("routes numeric flags through strict non-negative parsing", () => {
  expect(parseArgs(["--window-ms", "0"])).toMatchObject({ windowMs: 0 });
  expect(() => parseArgs(["--window-ms", "-1"])).toThrow(
    "--window-ms must be a non-negative integer",
  );
});

it("recognizes current and legacy gateway ready logs", () => {
  expect(hasGatewayReadyLog("[gateway] http server listening (0 plugins, 0.8s)")).toBe(true);
  expect(hasGatewayReadyLog("[gateway] ready (0 plugins, 0.8s)")).toBe(true);
  expect(hasGatewayReadyLog("\u001B[36m[gateway]\u001B[39m \u001B[36mready\u001B[39m")).toBe(true);
  expect(hasGatewayReadyLog("[gateway] starting HTTP server...")).toBe(false);
});

it("detects byte growth in existing dist-runtime paths", () => {
  const distRuntimeByteGrowth = calculateDistRuntimeByteGrowth(100, 2_097_253);
  expect(distRuntimeByteGrowth).toBe(2_097_153);
  expect(findings({ distRuntimeByteGrowth }).failures).toContain(
    "dist-runtime apparent byte growth 2097153 exceeded max 2097152",
  );
});

it("bounds in-memory watch output capture while keeping the newest logs", () => {
  const first = appendBoundedWatchLog("abc", "def", 8);
  expect(first).toEqual({ text: "abcdef", truncated: false });

  const second = appendBoundedWatchLog(first.text, "ghijkl", 8);
  expect(second).toEqual({ text: "efghijkl", truncated: true });
});

it.each([
  { reason: "missing_bundled_plugin_dist_entry", removedPaths: 0 },
  { reason: null, removedPaths: 2932 },
  { reason: "dirty_watched_tree", removedPaths: 0 },
])(
  "rejects prebuilt artifact mutation: $reason / $removedPaths removed",
  ({ reason, removedPaths }) => {
    const result = findings({
      distRuntimeByteGrowth: -1024,
      removedPaths,
      options: parseArgs(["--skip-build"]),
      watchBuildReason: reason,
      watchTriggeredBuild: reason !== null,
    });
    expect(result.failures).toEqual([
      removedPaths > 0
        ? "gateway:watch removed 2932 prebuilt artifact paths"
        : reason === "dirty_watched_tree"
          ? "gateway:watch invalid local run: dirty watched source tree forced a rebuild during the watch window"
          : "gateway:watch unexpectedly rebuilt prebuilt artifacts (missing_bundled_plugin_dist_entry)",
    ]);
  },
);

it("keeps build-regression detection after diagnostic logs truncate", () => {
  const detected = updateWatchBuildDetection(
    { buffer: "", triggered: false, reason: null },
    "Building TypeScript (dist is stale: source_mtime_newer)\n",
  );
  const afterNoise = updateWatchBuildDetection(detected, "x".repeat(10_000));

  expect(afterNoise).toMatchObject({ triggered: true, reason: "source_mtime_newer" });

  const coalesced = updateWatchBuildDetection(
    { buffer: "", triggered: false, reason: null },
    `Building TypeScript (dist is stale: config_newer)\n${"x".repeat(10_000)}`,
  );
  expect(coalesced).toMatchObject({ triggered: true, reason: "config_newer" });
});

it("uses bash for timed watch commands when available", () => {
  const command = buildTimedWatchCommand("watch.pid", "watch.time", "/tmp/openclaw-watch", 19042, {
    existsSync: (candidate: string) =>
      candidate === "/usr/bin/bash" || candidate === "/usr/bin/time",
  });
  const shellIndex = command.args.indexOf("/usr/bin/bash");

  if (shellIndex >= 0) {
    expect(command.args[shellIndex + 1]).toBe("-lc");
  } else {
    expect(command.command).toBe("/usr/bin/bash");
    expect(command.args[0]).toBe("-lc");
  }
});

it.each([
  [false, [0, 10_000], null, null, "gateway:watch did not report ready before the idle CPU window"],
  [
    true,
    [null, null],
    null,
    null,
    "failed to collect idle CPU timing from the ready gateway:watch window",
  ],
  [
    true,
    [50_000, 59_000],
    9_000,
    "fixture shutdown error",
    "gateway:watch failed to start: fixture shutdown error",
  ],
] as const)(
  "reports measurement readiness=%s samples=%j",
  async (ready, samples, idleCpuMs, lateError, failure) => {
    const { child, finish, onSignal, outputDir } = createWatchChildFixture();
    const timing = { userSeconds: 45.91, sysSeconds: 7.52, elapsedSeconds: 33.22 };
    const readCpu = vi
      .fn((_pid: number): number | null => null)
      .mockReturnValueOnce(samples[0] ?? null)
      .mockReturnValueOnce(samples[1] ?? null);
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    if (lateError) {
      if (process.platform === "win32") {
        vi.mocked(spawnSync).mockImplementationOnce(() => {
          finish();
          return {
            pid: 1235,
            status: 0,
            signal: null,
            output: [],
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          };
        });
      }
      onSignal.mockImplementationOnce(() => {
        child.emit("error", new Error(lateError));
        finish();
      });
    }
    const options = {
      ...parseArgs(["--skip-build"]),
      sigkillGraceMs: 1,
      sigkillExitGraceMs: 100,
    };
    const result = await runWatch(outputDir, options, {
      waitForGatewayReady: async () => ready,
      readProcessTreeCpuMs: readCpu,
      parseTimingFile: () => timing,
      sleep,
    });

    expect(result).toMatchObject({ readyBeforeWindow: ready, idleCpuMs, timing });
    expectStopped(child);
    expectHome(outputDir, false);
    expect(readCpu).toHaveBeenCalledTimes(ready ? 2 : 0);
    if (!ready) {
      expect(sleep).not.toHaveBeenCalled();
    }
    const collected = findings({
      options,
      watchBuildReason: result.watchBuildReason,
      watchResult: result,
      watchTriggeredBuild: result.watchTriggeredBuild,
    });
    expect(collected).toMatchObject({ failures: [failure], warnings: [] });
    expect(collected.limitViolations).toEqual(
      idleCpuMs !== null && idleCpuMs > options.cpuFailMs
        ? [
            {
              file: "scripts/check-gateway-watch-regression.mts",
              title: "Gateway watch CPU budget",
              message: "gateway:watch used 9000ms CPU in 10000ms window, above threshold 8000ms",
            },
          ]
        : [],
    );
  },
);

it.each([
  [false, 1, "gateway:watch exited before ready (code 1, signal null)"],
  [true, 0, "gateway:watch exited before the idle CPU window completed (code 0, signal null)"],
] as const)("reports premature exit with ready=%s", (ready, code, failure) => {
  const result = findings({
    watchResult: {
      exit: { code, signal: null },
      exitedBeforeReady: !ready,
      exitedBeforeStop: ready,
      readyBeforeWindow: ready,
    },
  });
  expect(result.failures).toContain(failure);
  if (!ready) {
    expect(result.failures).not.toContain(
      "gateway:watch did not report ready before the idle CPU window",
    );
  }
  expect(result.warnings).toEqual([]);
});

it("reports duplicate dist-runtime regression only for dist-runtime growth failures", () => {
  const failures = [
    "gateway:watch did not report ready before the idle CPU window",
    "dist-runtime file growth 201 exceeded max 200",
    "dist-runtime apparent byte growth 2097153 exceeded max 2097152",
  ];
  expect(failures.map((failure) => shouldReportDuplicateDistRuntimeRegression([failure]))).toEqual([
    false,
    true,
    true,
  ]);
});

it.each([
  [true, "config_newer", true],
  [false, "config_newer", false],
  [true, "source_mtime_newer", false],
] as const)("refreshes restored stamps: skip=%s reason=%s", (skipBuild, reason, expected) => {
  expect(
    shouldRefreshBuildStampForRestoredArtifacts({
      skipBuild,
      buildRequirement: { shouldBuild: true, reason },
    }),
  ).toBe(expected);
});

it("refreshes runtime postbuild stamps after build stamps", () => {
  const rootDir = tempDirs.make("openclaw-gateway-watch-stamps-");
  fs.mkdirSync(path.join(rootDir, ".git"), { recursive: true });
  writeBuildAndRuntimePostBuildStamps({ cwd: rootDir });

  const buildStampPath = path.join(rootDir, "dist", BUILD_STAMP_FILE);
  const runtimeStampPath = path.join(rootDir, "dist", RUNTIME_POSTBUILD_STAMP_FILE);
  expect(fs.statSync(runtimeStampPath).mtimeMs).toBeGreaterThanOrEqual(
    fs.statSync(buildStampPath).mtimeMs,
  );
});

it("retains restored stamp provenance", () => {
  const rootDir = tempDirs.make("openclaw-watch-restored-stamps-");
  fs.mkdirSync(path.join(rootDir, "dist"));
  const contents = JSON.stringify({ head: "producer-head", inputsClean: false });
  for (const name of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
    const filename = path.join(rootDir, "dist", name);
    fs.writeFileSync(filename, contents);
    fs.utimesSync(filename, 1, 1);
  }
  refreshLocalBuildStampTimes({ cwd: rootDir, now: () => 10_000 });
  for (const name of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
    const filename = path.join(rootDir, "dist", name);
    expect(fs.readFileSync(filename, "utf8")).toBe(contents);
    expect(fs.statSync(filename).mtimeMs).toBe(10_000);
  }
});

it.skipIf(process.platform === "win32")(
  "rejects unconfirmed cleanup and retains HOME after a valid idle measurement",
  { timeout: 2_000 },
  async () => {
    const outputDir = tempDirs.make("openclaw-gateway-watch-unjoined-");
    // Deliberately failed mock cleanup must not retain the worker's resource namespace.
    const owner = createVitestResourceOwner(outputDir);
    for (const variable of ["TMPDIR", "TMP", "TEMP"]) {
      vi.stubEnv(variable, outputDir);
    }
    const { child, finish, onSignal } = createWatchChildFixture(outputDir);
    onSignal.mockImplementation(() => {});
    const readCpu = vi.fn(() => 50_000);
    const completion = runWatch(
      outputDir,
      { readyTimeoutMs: 500, sigkillExitGraceMs: 25, windowMs: 1 },
      { readProcessTreeCpuMs: readCpu },
    );
    // Rescue the fake child if a regression loses the owner's short cleanup bound.
    const rescue = setTimeout(() => finish(), 1_000);
    try {
      await expect(completion).rejects.toMatchObject({
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState: "live",
      });

      expect(readCpu).toHaveBeenCalledTimes(2);
      expect(child).toMatchObject({ exitCode: null, signalCode: null });
      expectHome(outputDir, true);
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    } finally {
      clearTimeout(rescue);
      finish();
      await completion.catch(() => {});
    }
  },
);

it("joins the watch command before propagating a measurement error", async () => {
  const { child, finish, outputDir } = createWatchChildFixture();
  const measurementError = new Error("fixture CPU probe failed");
  const completion = runWatch(
    outputDir,
    { sigkillExitGraceMs: 100 },
    {
      waitForGatewayReady: async () => true,
      sleep: () => Promise.resolve(),
      readProcessTreeCpuMs: () => {
        throw measurementError;
      },
    },
  );
  try {
    await expect(completion).rejects.toBe(measurementError);
    expectStopped(child);
    expectHome(outputDir, false);
  } finally {
    finish();
    await completion.catch(() => {});
  }
});

it(
  "joins readiness after managed failure and a producer failure without child exit",
  { timeout: 2_000 },
  async () => {
    const outputDir = tempDirs.make("openclaw-gateway-watch-managed-failure-");
    for (const variable of ["TMPDIR", "TMP", "TEMP"]) {
      vi.stubEnv(variable, outputDir);
    }
    const { child, finish } = createWatchChildFixture(outputDir);
    const cleanupError = Object.assign(new Error("fixture managed cleanup failed"), {
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState: "live",
    });
    const producerError = Object.assign(new Error("fixture readiness producer failed"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
    const { promise: phaseStarted, resolve: startPhase } = Promise.withResolvers<void>();
    vi.mocked(runManagedCommand).mockImplementationOnce(async ({ onReady }) => {
      fs.writeFileSync(path.join(outputDir, "watch.pid"), "1234\n");
      onReady?.(child);
      await phaseStarted;
      throw cleanupError;
    });
    const rescueController = new AbortController();
    let phaseSignal: AbortSignal | undefined;
    let waitSignal: AbortSignal | undefined;
    let pendingWait: Promise<boolean> | undefined;
    const { sleep, expectSettled } = observedSleep(() => {}, 25);
    const completion = runWatch(
      outputDir,
      { sigkillExitGraceMs: 25, windowMs: 1 },
      {
        waitForGatewayReady: (_readText, timeoutMs, signal) => {
          phaseSignal = signal;
          waitSignal = AbortSignal.any([signal, rescueController.signal]);
          startPhase();
          pendingWait = sleep(timeoutMs, waitSignal).then(
            () => false,
            (error: unknown) => {
              if (signal?.aborted) {
                throw producerError;
              }
              throw error;
            },
          );
          return pendingWait;
        },
      },
    );
    const rescue = setTimeout(() => rescueController.abort(), 1_000);
    try {
      const error: unknown = await completion.catch((caughtError: unknown) => caughtError);
      expect(error).toBeInstanceOf(AggregateError);
      if (error instanceof AggregateError) {
        expect(error.errors).toHaveLength(2);
        expect(error.errors).toEqual(expect.arrayContaining([cleanupError, producerError]));
      }
      expect(phaseSignal?.aborted).toBe(true);
      expectSettled();
      expect(child).toMatchObject({ exitCode: null, signalCode: null });
      expectHome(outputDir, true);
    } finally {
      clearTimeout(rescue);
      rescueController.abort();
      finish();
      await completion.catch(() => {});
      await pendingWait?.catch((error: unknown) => {
        if (
          error === producerError ||
          (error instanceof Error && "cause" in error && error.cause === waitSignal?.reason)
        ) {
          return;
        }
        throw error;
      });
    }
  },
);

it("removes the isolated watch home after spawn failures", async () => {
  const outputDir = tempDirs.make("openclaw-gateway-watch-output-");
  const child = new WatchChildProcess();
  const { sleep, expectSettled } = observedSleep();
  const waitForGatewayReady = vi.fn(async () => false);
  const spawnChild = vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.emit("error", new Error("spawn failed"));
      child.stdout.destroy();
      child.stderr.destroy();
      child.emit("close", -1, null);
    });
    return child;
  });

  try {
    const result = await runWatch(
      outputDir,
      { readyTimeoutMs: 0, windowMs: 0 },
      { sleep, waitForGatewayReady },
    );

    expect(result.spawnError).toBe("spawn failed");
    expectHome(outputDir, false);
    expect(spawnChild.mock.calls[0]?.[2]?.env?.OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS).toBe("0");
    expect(waitForGatewayReady).not.toHaveBeenCalled();
    expectSettled();
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

it("releases default readiness timers so an early-exit observer finishes naturally", () => {
  const outputDir = tempDirs.make("openclaw-gateway-watch-readiness-exit-");
  const ownerUrl = resolveRuntimeWorkerUrl(toolingMtsEntrypoints.gatewayWatch);
  const nodeExecutable = resolveTestNodeExecPath();
  const result = spawnSync(
    nodeExecutable,
    [
      ...resolveRuntimeWorkerArgv(ownerUrl, nodeExecutable).slice(0, -1),
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const outputDir = ${JSON.stringify(outputDir)};
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
  if (!options?.env?.OPENCLAW_WATCH_PID_FILE) return originalSpawn(command, args, options);
  const child = originalSpawn(process.execPath, ["-e",
    'console.error("fixture watch exited before ready"); process.exitCode = 1;',
  ], options);
  fs.writeFileSync(options.env.OPENCLAW_WATCH_PID_FILE, String(child.pid) + "\\n");
  return child;
};
syncBuiltinESMExports();
const { runTimedWatch } = await import(${JSON.stringify(ownerUrl.href)});
const result = await runTimedWatch({
  readySettleMs: 0, readyTimeoutMs: 30_000, sigkillGraceMs: 1,
  sigkillExitGraceMs: 100, windowMs: 10_000,
}, outputDir, { allocateLoopbackPort: async () => 19042 });
assert.deepEqual(result.exit, { code: 1, signal: null });
assert.equal(result.exitedBeforeReady, true);
assert.equal(result.exitedBeforeStop, true);
assert.equal(result.readyBeforeWindow, false);
assert.equal(result.spawnError, null);
console.log("readiness observer settled");
`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: outputDir, TMP: outputDir, TEMP: outputDir },
      timeout: 5_000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.stdout, result.stderr).toContain("readiness observer settled");
  expect(result.error, result.stderr).toBeUndefined();
  expect(result, result.stderr).toMatchObject({ signal: null, status: 0 });
});

it.each([
  { phase: "startup", readySettleMs: 0 },
  { phase: "settle", readySettleMs: 250 },
  { phase: "idle", readySettleMs: 0 },
])("records watch exit during $phase and joins its observers", async ({ phase, readySettleMs }) => {
  const { child, finish, onSignal, spawnChild, outputDir } = createWatchChildFixture();
  const startup = phase === "startup";
  const { sleep, expectSettled } = observedSleep(() => {
    if (!startup) {
      queueMicrotask(() => finish());
    }
  });
  const readProcessTreeCpuMs = phase === "idle" ? vi.fn(() => 12) : undefined;
  const waitForGatewayReady = vi.fn(
    (_readText: () => string, timeoutMs: number, signal: AbortSignal) =>
      startup ? delay(timeoutMs, false, { signal }) : Promise.resolve(true),
  );
  if (startup) {
    spawnChild.mockReset().mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stderr.write("gateway startup failed\n");
        finish(1);
      });
      return child;
    });
  }

  try {
    const result = await runWatch(
      outputDir,
      { readySettleMs, windowMs: startup ? 10_000 : 250 },
      {
        ...(readProcessTreeCpuMs ? { readProcessTreeCpuMs } : {}),
        sleep,
        waitForGatewayReady,
      },
    );

    expectExit(result, startup ? 1 : 0, !startup);
    if (startup) {
      expect(result.spawnError).toBeNull();
      expect(fs.readFileSync(result.stderrPath, "utf8")).toContain("gateway startup failed");
      expect(waitForGatewayReady).not.toHaveBeenCalled();
    } else {
      expect(result.idleCpuMs).toBeNull();
    }
    if (readProcessTreeCpuMs) {
      expect(readProcessTreeCpuMs).toHaveBeenCalledOnce();
    }
    expect(onSignal).not.toHaveBeenCalled();
    expectSettled();
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
