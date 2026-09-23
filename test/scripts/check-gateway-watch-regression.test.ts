import { ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendBoundedWatchLog,
  buildTimedWatchCommand,
  calculateDistRuntimeByteGrowth,
  collectGatewayWatchFindings,
  hasGatewayReadyLog,
  parseArgs,
  resolveTimedWatchShell,
  runTimedWatch,
  shouldReportDuplicateDistRuntimeRegression,
  shouldRefreshBuildStampForRestoredArtifacts,
  updateWatchBuildDetection,
  WATCH_LOG_CAPTURE_MAX_CHARS,
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

function createWatchChildFixture(outputDir: string) {
  const exitState: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  };
  const child = new WatchChildProcess();
  Object.defineProperties(child, {
    pid: { configurable: true, value: 1234 },
    exitCode: { get: () => exitState.code },
    signalCode: { get: () => exitState.signal },
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
  return { child, finish, onSignal, spawnChild };
}

describe("check-gateway-watch-regression", () => {
  it("accepts package-manager argument separators before script options", () => {
    expect(parseArgs(["--", "--window-ms", "1500", "--skip-build"])).toMatchObject({
      skipBuild: true,
      windowMs: 1500,
    });
  });

  it("parses timing and growth limits as strict non-negative integers", () => {
    expect(
      parseArgs([
        "--window-ms",
        "0",
        "--ready-timeout-ms",
        "1",
        "--ready-settle-ms",
        "2",
        "--sigkill-grace-ms",
        "3",
        "--sigkill-exit-grace-ms",
        "4",
        "--cpu-warn-ms",
        "5",
        "--cpu-fail-ms",
        "6",
        "--dist-runtime-file-growth-max",
        "7",
        "--dist-runtime-byte-growth-max",
        "8",
      ]),
    ).toMatchObject({
      cpuFailMs: 6,
      cpuWarnMs: 5,
      distRuntimeByteGrowthMax: 8,
      distRuntimeFileGrowthMax: 7,
      readySettleMs: 2,
      readyTimeoutMs: 1,
      sigkillExitGraceMs: 4,
      sigkillGraceMs: 3,
      windowMs: 0,
    });

    for (const [value, message] of [
      ["1.5", "--window-ms must be a non-negative integer"],
      ["1e3", "--window-ms must be a non-negative integer"],
      ["-1", "--window-ms must be a non-negative integer"],
      ["9007199254740992", "--window-ms must be a safe integer"],
      ["soon", "--window-ms must be a non-negative integer"],
    ] as const) {
      expect(() => parseArgs(["--window-ms", value])).toThrow(message);
    }
  });

  it("recognizes current and legacy gateway ready logs", () => {
    expect(hasGatewayReadyLog("[gateway] http server listening (0 plugins, 0.8s)")).toBe(true);
    expect(hasGatewayReadyLog("[gateway] ready (0 plugins, 0.8s)")).toBe(true);
    expect(hasGatewayReadyLog("\u001B[36m[gateway]\u001B[39m \u001B[36mready\u001B[39m")).toBe(
      true,
    );
    expect(hasGatewayReadyLog("[gateway] starting HTTP server...")).toBe(false);
  });

  it("detects byte growth in existing dist-runtime paths", () => {
    const distRuntimeByteGrowth = calculateDistRuntimeByteGrowth(100, 2_097_253);
    const findings = collectGatewayWatchFindings({
      distRuntimeByteGrowth,
      distRuntimeFileGrowth: 0,
      removedPaths: 0,
      options: {
        cpuFailMs: 8000,
        cpuWarnMs: 1000,
        distRuntimeByteGrowthMax: 2 * 1024 * 1024,
        distRuntimeFileGrowthMax: 200,
        windowMs: 10_000,
      },
      watchBuildReason: null,
      watchResult: {
        idleCpuMs: 0,
        readyBeforeWindow: true,
        spawnError: null,
        timingFileMissing: false,
      },
      watchTriggeredBuild: false,
    });

    expect(distRuntimeByteGrowth).toBe(2_097_153);
    expect(findings.failures).toContain(
      "dist-runtime apparent byte growth 2097153 exceeded max 2097152",
    );
  });

  it("bounds in-memory watch output capture while keeping the newest logs", () => {
    const first = appendBoundedWatchLog("abc", "def", 8);
    expect(first).toEqual({ text: "abcdef", truncated: false });

    const second = appendBoundedWatchLog(first.text, "ghijkl", 8);
    expect(second).toEqual({ text: "efghijkl", truncated: true });
    expect(second.text).toHaveLength(8);
    expect(WATCH_LOG_CAPTURE_MAX_CHARS).toBeGreaterThan(1024);
  });

  it.each([
    { reason: "missing_bundled_plugin_dist_entry", removedPaths: 0 },
    { reason: null, removedPaths: 2932 },
    { reason: "dirty_watched_tree", removedPaths: 0 },
  ])(
    "rejects prebuilt artifact mutation: $reason / $removedPaths removed",
    ({ reason, removedPaths }) => {
      const findings = collectGatewayWatchFindings({
        distRuntimeByteGrowth: -1024,
        distRuntimeFileGrowth: 0,
        removedPaths,
        options: parseArgs(["--skip-build"]),
        watchBuildReason: reason,
        watchTriggeredBuild: reason !== null,
        watchResult: {
          idleCpuMs: 0,
          readyBeforeWindow: true,
          spawnError: null,
          timingFileMissing: false,
        },
      });
      expect(findings.failures).toEqual([
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

    expect(afterNoise.triggered).toBe(true);
    expect(afterNoise.reason).toBe("source_mtime_newer");

    const coalesced = updateWatchBuildDetection(
      { buffer: "", triggered: false, reason: null },
      `Building TypeScript (dist is stale: config_newer)\n${"x".repeat(10_000)}`,
    );
    expect(coalesced.triggered).toBe(true);
    expect(coalesced.reason).toBe("config_newer");
  });

  it("uses bash for timed watch commands when available", () => {
    expect(
      resolveTimedWatchShell({
        existsSync: (candidate: string) => candidate === "/usr/bin/bash",
      }),
    ).toBe("/usr/bin/bash");

    const command = buildTimedWatchCommand(
      "watch.pid",
      "watch.time",
      "/tmp/openclaw-watch",
      19042,
      {
        existsSync: (candidate: string) =>
          candidate === "/usr/bin/bash" || candidate === "/usr/bin/time",
      },
    );
    const shellIndex = command.args.indexOf("/usr/bin/bash");

    if (shellIndex >= 0) {
      expect(command.args[shellIndex + 1]).toBe("-lc");
    } else {
      expect(command.command).toBe("/usr/bin/bash");
      expect(command.args[0]).toBe("-lc");
    }
  });

  it("runs gateway watch through the parent Node binary", () => {
    const nodeExecPath = "/opt/hostedtoolcache/node/24.11.1/x64/bin/node";
    const command = buildTimedWatchCommand(
      "watch.pid",
      "watch.time",
      "/tmp/openclaw-watch",
      19042,
      {
        existsSync: (candidate: string) =>
          candidate === "/usr/bin/bash" || candidate === "/usr/bin/time",
        nodeExecPath,
      },
    );
    const shellSource = command.args.at(-1);

    expect(shellSource).toContain(`exec '${nodeExecPath}' scripts/watch-node.mjs gateway --force`);
    expect(command.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(nodeExecPath));
  });

  it.each([
    {
      name: "readiness timeout does not measure startup as idle",
      ready: false,
      samples: [0, 10_000],
      idleCpuMs: null,
      lateError: null,
      failures: ["gateway:watch did not report ready before the idle CPU window"],
    },
    {
      name: "zero idle CPU is independent of high lifetime CPU",
      ready: true,
      samples: [50_000, 50_000],
      idleCpuMs: 0,
      lateError: null,
      failures: [],
    },
    {
      name: "missing idle samples cannot use lifetime CPU",
      ready: true,
      samples: [null, null],
      idleCpuMs: null,
      lateError: null,
      failures: ["failed to collect idle CPU timing from the ready gateway:watch window"],
    },
    {
      name: "valid high idle CPU still alarms after a later process error",
      ready: true,
      samples: [50_000, 59_000],
      idleCpuMs: 9_000,
      lateError: "fixture shutdown error",
      failures: [
        "gateway:watch failed to start: fixture shutdown error",
        "LOUD ALARM: gateway:watch used 9000ms CPU in 10000ms window, above loud-alarm threshold 8000ms",
      ],
    },
  ])("$name", async ({ ready, samples, idleCpuMs, lateError, failures }) => {
    const outputDir = tempDirs.make("openclaw-gateway-watch-measurement-");
    const { child, finish, onSignal } = createWatchChildFixture(outputDir);
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
    const result = await runTimedWatch(options, outputDir, {
      allocateLoopbackPort: async () => 19042,
      waitForGatewayReady: async () => ready,
      readProcessTreeCpuMs: readCpu,
      parseTimingFile: () => timing,
      sleep,
    });

    expect(result.readyBeforeWindow).toBe(ready);
    expect(result.idleCpuMs).toBe(idleCpuMs);
    expect(result.timing).toEqual(timing);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.closed).toBe(true);
    expect(child.stderr.closed).toBe(true);
    const isolatedHomeDir = fs.readFileSync(path.join(outputDir, "watch.home.txt"), "utf8").trim();
    expect(fs.existsSync(isolatedHomeDir)).toBe(false);
    expect(readCpu).toHaveBeenCalledTimes(ready ? 2 : 0);
    if (!ready) {
      expect(sleep).not.toHaveBeenCalled();
    }
    const findings = collectGatewayWatchFindings({
      distRuntimeByteGrowth: 0,
      distRuntimeFileGrowth: 0,
      removedPaths: 0,
      options,
      watchBuildReason: result.watchBuildReason,
      watchResult: result,
      watchTriggeredBuild: result.watchTriggeredBuild,
    });
    expect(findings.failures).toEqual(failures);
    expect(findings.warnings).toEqual([]);
  });

  it("reports early gateway watch exit before readiness distinctly", () => {
    const findings = collectGatewayWatchFindings({
      distRuntimeByteGrowth: 0,
      distRuntimeFileGrowth: 0,
      removedPaths: 0,
      options: {
        cpuFailMs: 8000,
        cpuWarnMs: 1000,
        distRuntimeByteGrowthMax: 2 * 1024 * 1024,
        distRuntimeFileGrowthMax: 200,
        windowMs: 10_000,
      },
      watchBuildReason: null,
      watchResult: {
        exit: { code: 1, signal: null },
        exitedBeforeReady: true,
        idleCpuMs: 0,
        readyBeforeWindow: false,
        spawnError: null,
        timingFileMissing: false,
      },
      watchTriggeredBuild: false,
    });

    expect(findings.failures).toContain("gateway:watch exited before ready (code 1, signal null)");
    expect(findings.failures).not.toContain(
      "gateway:watch did not report ready before the idle CPU window",
    );
    expect(findings.warnings).toEqual([]);
  });

  it("reports gateway watch exit after readiness before the idle window completes", () => {
    const findings = collectGatewayWatchFindings({
      distRuntimeByteGrowth: 0,
      distRuntimeFileGrowth: 0,
      removedPaths: 0,
      options: {
        cpuFailMs: 8000,
        cpuWarnMs: 1000,
        distRuntimeByteGrowthMax: 2 * 1024 * 1024,
        distRuntimeFileGrowthMax: 200,
        windowMs: 10_000,
      },
      watchBuildReason: null,
      watchResult: {
        exit: { code: 0, signal: null },
        exitedBeforeReady: false,
        exitedBeforeStop: true,
        idleCpuMs: 0,
        readyBeforeWindow: true,
        spawnError: null,
        timingFileMissing: false,
      },
      watchTriggeredBuild: false,
    });

    expect(findings.failures).toContain(
      "gateway:watch exited before the idle CPU window completed (code 0, signal null)",
    );
    expect(findings.warnings).toEqual([]);
  });

  it("reports duplicate dist-runtime regression only for dist-runtime growth failures", () => {
    expect(
      shouldReportDuplicateDistRuntimeRegression([
        "gateway:watch did not report ready before the idle CPU window",
      ]),
    ).toBe(false);
    expect(
      shouldReportDuplicateDistRuntimeRegression(["dist-runtime file growth 201 exceeded max 200"]),
    ).toBe(true);
    expect(
      shouldReportDuplicateDistRuntimeRegression([
        "dist-runtime apparent byte growth 2097153 exceeded max 2097152",
      ]),
    ).toBe(true);
  });

  it("refreshes restored build stamps only for skip-build config mtime drift", () => {
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: true,
        buildRequirement: { shouldBuild: true, reason: "config_newer" },
      }),
    ).toBe(true);
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: false,
        buildRequirement: { shouldBuild: true, reason: "config_newer" },
      }),
    ).toBe(false);
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: true,
        buildRequirement: { shouldBuild: true, reason: "source_mtime_newer" },
      }),
    ).toBe(false);
  });

  it("refreshes runtime postbuild stamps after build stamps", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-watch-stamps-"));
    try {
      fs.mkdirSync(path.join(rootDir, ".git"), { recursive: true });
      writeBuildAndRuntimePostBuildStamps({ cwd: rootDir });

      const buildStampPath = path.join(rootDir, "dist", BUILD_STAMP_FILE);
      const runtimeStampPath = path.join(rootDir, "dist", RUNTIME_POSTBUILD_STAMP_FILE);
      expect(fs.existsSync(buildStampPath)).toBe(true);
      expect(fs.existsSync(runtimeStampPath)).toBe(true);
      expect(fs.statSync(runtimeStampPath).mtimeMs).toBeGreaterThanOrEqual(
        fs.statSync(buildStampPath).mtimeMs,
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it.each([false, null, undefined])("retains restored stamp provenance (%s)", (inputsClean) => {
    const rootDir = tempDirs.make("openclaw-watch-restored-stamps-");
    fs.mkdirSync(path.join(rootDir, "dist"));
    const contents = JSON.stringify({ head: "producer-head", inputsClean });
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
      const completion = runTimedWatch(
        {
          readySettleMs: 0,
          readyTimeoutMs: 500,
          sigkillGraceMs: 1,
          sigkillExitGraceMs: 25,
          windowMs: 1,
        },
        outputDir,
        {
          allocateLoopbackPort: async () => 19042,
          readProcessTreeCpuMs: readCpu,
        },
      );
      // Rescue the fake child if a regression loses the owner's short cleanup bound.
      const rescue = setTimeout(() => finish(), 1_000);
      try {
        await expect(completion).rejects.toMatchObject({
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: "live",
        });

        expect(readCpu).toHaveBeenCalledTimes(2);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        const isolatedHomeDir = fs
          .readFileSync(path.join(outputDir, "watch.home.txt"), "utf8")
          .trim();
        expect(fs.existsSync(isolatedHomeDir)).toBe(true);
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      } finally {
        clearTimeout(rescue);
        finish();
        await completion.catch(() => {});
      }
    },
  );

  it("joins the watch command before propagating a measurement error", async () => {
    const outputDir = tempDirs.make("openclaw-gateway-watch-measurement-error-");
    const { child, finish } = createWatchChildFixture(outputDir);
    const measurementError = new Error("fixture CPU probe failed");
    const completion = runTimedWatch(
      { ...parseArgs(["--skip-build"]), sigkillGraceMs: 1, sigkillExitGraceMs: 100 },
      outputDir,
      {
        allocateLoopbackPort: async () => 19042,
        waitForGatewayReady: async () => true,
        sleep: () => Promise.resolve(),
        readProcessTreeCpuMs: () => {
          throw measurementError;
        },
      },
    );
    try {
      await expect(completion).rejects.toBe(measurementError);
      expect(child.exitCode).toBe(0);
      expect(child.stdout.closed).toBe(true);
      expect(child.stderr.closed).toBe(true);
      const isolatedHomeDir = fs
        .readFileSync(path.join(outputDir, "watch.home.txt"), "utf8")
        .trim();
      expect(fs.existsSync(isolatedHomeDir)).toBe(false);
    } finally {
      finish();
      await completion.catch(() => {});
    }
  });

  it.each([false, true])(
    "joins readiness after managed failure without child exit (producer failure: %s)",
    { timeout: 2_000 },
    async (producerFails) => {
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
      let startPhase!: () => void;
      const phaseStarted = new Promise<void>((resolve) => {
        startPhase = resolve;
      });
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
      let waitSettled = false;
      const completion = runTimedWatch(
        {
          readySettleMs: 0,
          readyTimeoutMs: 30_000,
          sigkillGraceMs: 1,
          sigkillExitGraceMs: 25,
          windowMs: 1,
        },
        outputDir,
        {
          allocateLoopbackPort: async () => 19042,
          waitForGatewayReady: (_readText, timeoutMs, signal) => {
            phaseSignal = signal;
            waitSignal = signal
              ? AbortSignal.any([signal, rescueController.signal])
              : rescueController.signal;
            startPhase();
            pendingWait = (async () => {
              try {
                return await delay(timeoutMs, false, { signal: waitSignal });
              } catch (error) {
                if (producerFails && signal?.aborted) {
                  throw producerError;
                }
                throw error;
              } finally {
                await delay(25);
                waitSettled = true;
              }
            })();
            return pendingWait;
          },
        },
      );
      const rescue = setTimeout(() => rescueController.abort(), 1_000);
      try {
        const error: unknown = await completion.catch((caughtError: unknown) => caughtError);
        if (producerFails) {
          expect(error).toBeInstanceOf(AggregateError);
          if (error instanceof AggregateError) {
            expect(error.errors).toHaveLength(2);
            expect(error.errors).toContain(cleanupError);
            expect(error.errors).toContain(producerError);
          }
        } else {
          expect(error).toBe(cleanupError);
        }
        expect(phaseSignal?.aborted).toBe(true);
        expect(waitSettled).toBe(true);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        const isolatedHomeDir = fs
          .readFileSync(path.join(outputDir, "watch.home.txt"), "utf8")
          .trim();
        expect(fs.existsSync(isolatedHomeDir)).toBe(true);
      } finally {
        clearTimeout(rescue);
        rescueController.abort();
        finish();
        await completion.catch(() => {});
        await pendingWait?.catch((error: unknown) => {
          if (producerFails && error === producerError) {
            return;
          }
          if (error instanceof Error && "cause" in error && error.cause === waitSignal?.reason) {
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
    let sleepSettled = false;
    const sleep = vi.fn(async (ms: number, signal: AbortSignal) => {
      try {
        await delay(ms, undefined, { signal });
      } finally {
        await delay(50);
        sleepSettled = true;
      }
    });
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
      const result = await runTimedWatch(
        {
          readySettleMs: 0,
          readyTimeoutMs: 0,
          sigkillGraceMs: 1,
          windowMs: 0,
        },
        outputDir,
        {
          allocateLoopbackPort: async () => 19042,
          sleep,
          waitForGatewayReady,
        },
      );

      const isolatedHomeDir = fs
        .readFileSync(path.join(outputDir, "watch.home.txt"), "utf8")
        .trim();
      expect(result.spawnError).toBe("spawn failed");
      expect(fs.existsSync(isolatedHomeDir)).toBe(false);
      expect(fs.existsSync(path.join(outputDir, "watch.home.txt"))).toBe(true);
      expect(spawnChild.mock.calls[0]?.[2]?.env?.OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS).toBe(
        "0",
      );
      expect(waitForGatewayReady).not.toHaveBeenCalled();
      expect(sleepSettled).toBe(true);
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
import { PassThrough } from "node:stream";
const outputDir = ${JSON.stringify(outputDir)};
const child = Object.assign(new cp.ChildProcess(), {
  pid: 1234, stdout: new PassThrough(), stderr: new PassThrough(),
});
for (const output of [child.stdout, child.stderr]) {
  output.once("close", () => {
    if (child.stdout.closed && child.stderr.closed) child.emit("close", 1, null);
  });
}
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
  if (!options?.env?.OPENCLAW_WATCH_PID_FILE) return originalSpawn(command, args, options);
  fs.writeFileSync(options.env.OPENCLAW_WATCH_PID_FILE, "1234\\n");
  setTimeout(() => {
    child.stderr.write("fixture watch exited before ready\\n");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.stdout.destroy();
    child.stderr.destroy();
  }, 20);
  return child;
};
const originalKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (Math.abs(pid) !== child.pid) return originalKill(pid, signal);
  if (child.exitCode !== null) {
    throw Object.assign(new Error("fixture child exited"), { code: "ESRCH" });
  }
  return true;
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
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  });

  it("stops waiting for readiness when the watch process exits early", async () => {
    const outputDir = tempDirs.make("openclaw-gateway-watch-output-");
    const { child, finish, onSignal, spawnChild } = createWatchChildFixture(outputDir);
    let sleepSettled = false;
    const sleep = vi.fn(async (ms: number, signal: AbortSignal) => {
      try {
        await delay(ms, undefined, { signal });
      } finally {
        await delay(50);
        sleepSettled = true;
      }
    });
    const waitForGatewayReady = vi.fn(
      (_readText: () => string, timeoutMs: number, signal: AbortSignal) =>
        delay(timeoutMs, false, { signal }),
    );
    spawnChild.mockReset().mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stderr.write("gateway startup failed\n");
        finish(1);
      });
      return child;
    });

    try {
      const result = await runTimedWatch(
        {
          readySettleMs: 0,
          readyTimeoutMs: 30_000,
          sigkillGraceMs: 1,
          windowMs: 10_000,
        },
        outputDir,
        {
          allocateLoopbackPort: async () => 19042,
          sleep,
          waitForGatewayReady,
        },
      );

      expect(result.exit).toEqual({ code: 1, signal: null });
      expect(result.exitedBeforeReady).toBe(true);
      expect(result.exitedBeforeStop).toBe(true);
      expect(result.readyBeforeWindow).toBe(false);
      expect(result.spawnError).toBeNull();
      expect(fs.readFileSync(result.stderrPath, "utf8")).toContain("gateway startup failed");
      expect(waitForGatewayReady).not.toHaveBeenCalled();
      expect(sleepSettled).toBe(true);
      expect(onSignal).not.toHaveBeenCalled();
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it.each([
    { phase: "settle", readySettleMs: 250 },
    { phase: "idle", readySettleMs: 0 },
  ])(
    "records a ready gateway watch exit during the $phase window as unplanned",
    async ({ phase, readySettleMs }) => {
      const outputDir = tempDirs.make("openclaw-gateway-watch-output-");
      const { child, finish, onSignal } = createWatchChildFixture(outputDir);
      let sleepSettled = false;
      const sleep = vi.fn(async (ms: number, signal: AbortSignal) => {
        queueMicrotask(() => finish());
        try {
          await delay(ms, undefined, { signal });
        } finally {
          await delay(50);
          sleepSettled = true;
        }
      });
      const readProcessTreeCpuMs = phase === "idle" ? vi.fn(() => 12) : undefined;

      try {
        const result = await runTimedWatch(
          {
            readySettleMs,
            readyTimeoutMs: 30_000,
            sigkillGraceMs: 1,
            windowMs: 250,
          },
          outputDir,
          {
            allocateLoopbackPort: async () => 19042,
            ...(readProcessTreeCpuMs ? { readProcessTreeCpuMs } : {}),
            sleep,
            waitForGatewayReady: async () => true,
          },
        );

        expect(result.exit).toEqual({ code: 0, signal: null });
        expect(result.exitedBeforeReady).toBe(false);
        expect(result.exitedBeforeStop).toBe(true);
        expect(result.readyBeforeWindow).toBe(true);
        expect(result.idleCpuMs).toBeNull();
        if (readProcessTreeCpuMs) {
          expect(readProcessTreeCpuMs).toHaveBeenCalledOnce();
        }
        expect(onSignal).not.toHaveBeenCalled();
        expect(sleepSettled).toBe(true);
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    },
  );
});
