// Tests node process runner lifecycle and captured output.
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, onTestFinished, vi } from "vitest";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import { acquireRunNodeBuildLock, resolveBuildRequirement } from "../../scripts/run-node.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  it,
  ROOT_SRC,
  ROOT_TSCONFIG,
  ROOT_PACKAGE,
  BUILD_STAMP,
  RUNTIME_POSTBUILD_STAMP,
  QA_LAB_PLUGIN_SDK_ENTRY,
  QA_RUNTIME_PLUGIN_SDK_ENTRY,
  EXTENSION_README,
  EXTENSION_SRC,
  EXTENSION_EXTRA_SRC,
  EXTENSION_MANIFEST,
  EXTENSION_PACKAGE,
  DIST_EXTENSION_SRC,
  NEW_TIME,
  createExitedProcess,
  createPipedExitedProcess,
  createFakeProcess,
  skipRuntimePostBuild,
  firstMockCall,
  writeRuntimePostBuildScaffold,
  expectedBuildSpawn,
  resolvePath,
  isTsxScriptArgs,
  touchProjectFiles,
  setupStampedProject,
  createCurrentGitSpawnRecorder,
  createSpawnRecorder,
  createBuildRequirementDeps,
  trackProjectWithGit,
  runNodeCommand,
  runQaCommand,
} from "../../test/scripts/run-node.test-support.js";

beforeEach(() => {
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
});

describe("run-node script", () => {
  it("routes local build stdout to stderr before JSON command output", async ({ tmp }) => {
    await writeRuntimePostBuildScaffold(tmp);
    const outputPath = path.join(tmp, ".artifacts", "run-node", "output.log");
    const spawn = (_cmd: string, args: string[]) => {
      if (isTsxScriptArgs(args, "scripts/build-all.mts")) {
        return createPipedExitedProcess({
          stdout: "asset stdout\nbuild stdout\n",
          stderr: "asset stderr\nbuild stderr\n",
        });
      }
      return createPipedExitedProcess({ stdout: '{"plugins":[]}\n' });
    };
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = {
      write: (chunk: string | Buffer) => {
        stdoutChunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const exitCode = await runNodeCommand(tmp, {
      args: ["plugins", "list", "--json"],
      env: { OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath },
      spawn,
      stdout,
      stderr: { write: (chunk) => stderrChunks.push(String(chunk)) },
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(stdoutChunks.join("")).toBe('{"plugins":[]}\n');
    expect(stderrChunks.join("")).toContain("asset stdout\n");
    expect(stderrChunks.join("")).toContain("asset stderr\n");
    expect(stderrChunks.join("")).toContain("build stdout\n");
    expect(stderrChunks.join("")).toContain("build stderr\n");
  });

  it("rebuilds when git HEAD changes even if source mtimes do not exceed the old build stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [QA_LAB_PLUGIN_SDK_ENTRY]: "export {};\n",
        [QA_RUNTIME_PLUGIN_SDK_ENTRY]: "export {};\n",
      },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({ gitHead: "def456\n" });
    const exitCode = await runQaCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([
      expectedBuildSpawn(),
      [
        process.execPath,
        "openclaw.mjs",
        "qa",
        "suite",
        "--transport",
        "qa-channel",
        "--provider-mode",
        "mock-openai",
      ],
    ]);
  });

  it.for([
    { filePath: "extensions/demo/src/café.ts", watched: true },
    { filePath: EXTENSION_README, watched: false },
    { filePath: "src/..ignored.test.ts", watched: false },
    ...(process.platform === "win32"
      ? []
      : [
          { filePath: "src/line\nname.ts", watched: true },
          { filePath: "src/ignored.test.ts ", watched: true },
        ]),
  ])(
    "reports watched source changes with real Git: $filePath",
    async ({ filePath, watched }, { tmp }) => {
      await setupStampedProject(tmp, {
        files: { [filePath]: "export const value = 1;\n" },
        trackConfig: true,
      });
      const { git, deps } = await trackProjectWithGit(tmp);
      expect(resolveBuildRequirement(deps)).toEqual({ shouldBuild: false, reason: "clean" });

      await fs.writeFile(resolvePath(tmp, filePath), "export const value = 2;\n");
      await touchProjectFiles(tmp, [filePath], NEW_TIME);
      for (const quotePath of ["true", "false"]) {
        git("config", "core.quotePath", quotePath);
        expect(resolveBuildRequirement(deps)).toEqual({
          shouldBuild: watched,
          reason: watched ? "dirty_watched_tree" : "clean",
        });
      }
      const { spawnSync } = createSpawnRecorder();
      expect(resolveBuildRequirement({ ...deps, spawnSync })).toEqual({
        shouldBuild: watched,
        reason: watched ? "source_mtime_newer" : "clean",
      });
    },
  );

  it.for([
    { args: ["--profile", "ci", "qa", "mantis", "run"], mantis: true },
    { args: ["--profile", "qa", "mantis", "run"], mantis: false },
    { args: ["status", "qa", "mantis", "run"], mantis: false },
  ])(
    "grants Mantis lifecycle IPC only to the parsed command: %j",
    async ({ args, mantis }, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
      const fakeProcess = Object.assign(createFakeProcess(), { stdin: { isTTY: true } });
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      const { promise: childSpawned, resolve: markChildSpawned } = createDeferred();
      const spawn = vi.fn((_cmd: string, childArgs: string[], _options: unknown) => {
        if (!childArgs.includes("openclaw.mjs")) {
          return createExitedProcess(0);
        }
        markChildSpawned();
        return child;
      });
      const outcome = runNodeCommand(tmp, {
        args,
        process: fakeProcess,
        spawn,
        runRuntimePostBuild: skipRuntimePostBuild,
      });
      // Lifecycle listeners attach in the spawn call stack, after async build/postbuild work.
      await Promise.race([childSpawned, outcome]);
      try {
        expect(child.listenerCount("exit")).toBe(1);
        vi.useFakeTimers();
        child.emit("message", { type: "openclaw:shutdown-grace", graceMs: 120_000 });
        fakeProcess.emit("SIGTERM");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(child.kill.mock.calls).toEqual(mantis ? [["SIGTERM"]] : [["SIGTERM"], ["SIGKILL"]]);
        if (mantis) {
          await vi.advanceTimersByTimeAsync(115_000);
          expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
        }
      } finally {
        child.emit("exit", 0, null);
        await outcome;
        vi.useRealTimers();
      }
      expect(await outcome).toBe(143);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it.for([undefined, "node", "bun"])(
    "starts the %s CLI only after the Node runtime build completes",
    async (runtime, { tmp }) => {
      const build = new EventEmitter();
      const fakeProcess = createFakeProcess();
      const { promise: buildSpawned, resolve: markBuildSpawned } = createDeferred();
      const spawn = vi.fn((_cmd: string, args: string[]) => {
        if (!isTsxScriptArgs(args, "scripts/build-all.mts")) {
          return createExitedProcess(0);
        }
        markBuildSpawned();
        return build;
      });
      const runRuntimePostBuild = vi.fn();
      const result = runNodeCommand(tmp, {
        spawn,
        process: fakeProcess,
        env: {
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_VITEST_RUNTIME: runtime,
          OPENCLAW_TRACE_SYNC_IO: "1",
        },
        runRuntimePostBuild,
      });
      await Promise.race([buildSpawned, result]);
      expect(spawn).toHaveBeenCalledOnce();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
      expect(fsSync.existsSync(lockDir)).toBe(true);
      expect(fakeProcess.listenerCount("exit")).toBe(1);
      build.emit("exit", 0, null);

      expect(await result).toBe(0);
      expect(spawn.mock.calls.map(([cmd, args]) => [cmd].concat(args))).toEqual([
        expectedBuildSpawn(),
        [runtime === "bun" ? "bun" : process.execPath, "--trace-sync-io", "openclaw.mjs", "status"],
      ]);
      // The canonical profile owns metadata and both stamps; the local runner
      // only invokes postbuild directly on its separate metadata-only path.
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
      expect(fsSync.existsSync(lockDir)).toBe(false);
      expect(fakeProcess.listenerCount("exit")).toBe(0);
    },
  );

  it("returns the canonical build failure without starting the CLI", async ({ tmp }) => {
    const spawn = vi.fn((cmd: string, args: string[] = []) => {
      if (cmd === process.execPath && isTsxScriptArgs(args, "scripts/build-all.mts")) {
        return createExitedProcess(23);
      }
      return createExitedProcess(0);
    });

    const exitCode = await runNodeCommand(tmp, { env: { OPENCLAW_FORCE_BUILD: "1" }, spawn });

    expect(exitCode).toBe(23);
    expect(spawn).toHaveBeenCalledOnce();
    expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
  });

  it("returns failure and releases the build lock when the canonical build spawn errors", async ({
    tmp,
  }) => {
    const spawn = vi.fn((cmd: string, args: string[] = []) => {
      if (cmd === process.execPath && isTsxScriptArgs(args, "scripts/build-all.mts")) {
        const events = new EventEmitter();
        queueMicrotask(() => events.emit("error", new Error("spawn failed")));
        return events;
      }
      return createExitedProcess(0);
    });

    const exitCode = await runNodeCommand(tmp, { env: { OPENCLAW_FORCE_BUILD: "1" }, spawn });

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
  });

  it.runIf(process.platform !== "win32").for([false, true])(
    "force-cleans the active child process group after SIGTERM (rebuild: %s)",
    async (rebuild, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

      const fakeProcess = Object.assign(createFakeProcess(), { stdin: { isTTY: false } });
      const child = Object.assign(new EventEmitter(), {
        pid: 42_420,
        kill: vi.fn(),
      });
      const groupSignals: Array<[number, string | number]> = [];
      const { promise: childSpawned, resolve: markChildSpawned } = createDeferred();
      const spawn = vi.fn((_cmd: string, _args: string[], _options: SpawnOptions) => {
        markChildSpawned();
        return child;
      });

      const exitCodePromise = runNodeCommand(tmp, {
        env: { OPENCLAW_FORCE_BUILD: rebuild ? "1" : "0", OPENCLAW_VITEST_RUNTIME: "bun" },
        platform: "darwin",
        process: fakeProcess,
        signalProcess: (pid: number, signal?: string | number) => {
          groupSignals.push([pid, signal ?? "SIGTERM"]);
          if (signal === "SIGTERM") {
            queueMicrotask(() => child.emit("exit", 0, null));
          }
          return true;
        },
        spawn,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      await Promise.race([childSpawned, exitCodePromise]);
      expect(spawn).toHaveBeenCalled();
      fakeProcess.emit("SIGTERM");
      const exitCode = await exitCodePromise;

      expect(exitCode).toBe(143);
      const spawnCall = firstMockCall(spawn);
      expect(spawnCall?.[0]).toBe(rebuild ? process.execPath : "bun");
      expect(spawnCall?.[1]).toEqual(
        rebuild ? expectedBuildSpawn().slice(1) : ["openclaw.mjs", "status"],
      );
      expect(spawnCall?.[2]).toMatchObject({
        detached: true,
        stdio: rebuild ? ["inherit", "pipe", "pipe"] : "inherit",
      });
      expect(spawn).toHaveBeenCalledOnce();
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
      expect(groupSignals).toEqual([
        [-42_420, "SIGTERM"],
        [-42_420, "SIGKILL"],
      ]);
      expect(child.kill).not.toHaveBeenCalled();
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("rechecks a dirty dashboard client after waiting for an active build", async ({ tmp }) => {
    await setupStampedProject(tmp, { trackConfig: true });
    await fs.rm(resolvePath(tmp, BUILD_STAMP));

    const lockProcess = Object.assign(createFakeProcess(), {
      kill: vi.fn(() => true),
    }) as unknown as NodeJS.Process;
    const releaseLock = await acquireRunNodeBuildLock({
      cwd: tmp,
      args: ["gateway"],
      env: { OPENCLAW_RUNNER_LOG: "0" },
      fs: fsSync,
      process: lockProcess,
      stderr: { write: () => true },
    });
    const { promise: waitingForLock, resolve: markWaiting } = createDeferred();
    const stderr = {
      write: (chunk: string | Uint8Array) => {
        if (String(chunk).includes("Waiting for TypeScript/runtime artifact lock")) {
          markWaiting();
        }
        return true;
      },
    };
    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${ROOT_SRC}\0`,
    });
    const clientRun = runNodeCommand(tmp, {
      args: ["dashboard", "--no-open", "--yes"],
      env: { OPENCLAW_RUNNER_LOG: "1", OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "1" },
      spawn,
      spawnSync,
      process: lockProcess,
      stderr,
      runRuntimePostBuild,
    });

    await waitingForLock;
    for (const stamp of [BUILD_STAMP, RUNTIME_POSTBUILD_STAMP]) {
      await fs.writeFile(
        resolvePath(tmp, stamp),
        '{"head":"abc123","inputsClean":true}\n',
        "utf-8",
      );
    }
    releaseLock();

    await expect(clientRun).resolves.toBe(0);
    expect(spawnCalls).toEqual([
      [process.execPath, "openclaw.mjs", "dashboard", "--no-open", "--yes"],
    ]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it.for([
    { gitStatus: ` M ${EXTENSION_PACKAGE}\0`, reason: "dirty_watched_tree" },
    { gitStatus: "", reason: "missing_bundled_plugin_dist_entry" },
  ])(
    "rebuilds partially missing plugin outputs: $reason",
    async ({ gitStatus, reason }, { tmp }) => {
      await setupStampedProject(tmp, {
        files: {
          [EXTENSION_SRC]: "export default {};\n",
          [EXTENSION_EXTRA_SRC]: "export const extra = true;\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts","./src/extra.ts"]}}\n',
          [DIST_EXTENSION_SRC]: "export default {};\n",
        },
        trackConfig: true,
      });
      expect(resolveBuildRequirement(createBuildRequirementDeps(tmp, { gitStatus }))).toEqual({
        shouldBuild: true,
        reason,
      });
    },
  );

  describe("acquireRunNodeBuildLock", () => {
    const lockDeps = (tmp: string, fakeProcess: NodeJS.Process) => ({
      cwd: tmp,
      args: ["status"],
      env: { OPENCLAW_RUNNER_LOG: "0" },
      fs: fsSync,
      process: fakeProcess,
      stderr: { write: () => true },
    });

    it("releases the lock directory on process exit", async ({ tmp }) => {
      const fakeProcess = createFakeProcess();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fsSync.existsSync(lockDir)).toBe(true);

      fakeProcess.emit("exit");
      expect(fsSync.existsSync(lockDir)).toBe(false);
      expect(release()).toBeUndefined();
    });

    it("wakes a contended lock wait when cancellation arrives", async ({ tmp }) => {
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, args: ["gateway"] }),
        "utf-8",
      );
      const controller = new AbortController();
      const waiting = acquireRunNodeBuildLock(
        {
          ...lockDeps(tmp, createFakeProcess()),
          env: { OPENCLAW_RUNNER_LOG: "0", OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "600000" },
        },
        controller.signal,
      );
      controller.abort();

      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(fsSync.existsSync(lockDir)).toBe(true);
    });

    it("removes a lock left by a dead wrapper process without waiting for age-out", async ({
      tmp,
    }) => {
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: 987654, args: ["gateway"] }),
        "utf-8",
      );

      const fakeProcess = Object.assign(createFakeProcess(), {
        kill: vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
          if (pid === 987654 && signal === 0) {
            const err = new Error("missing process") as Error & { code: string };
            err.code = "ESRCH";
            throw err;
          }
          return true;
        }),
      }) as unknown as NodeJS.Process;

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fakeProcess["kill"]).toHaveBeenCalledWith(987654, 0);
      expect(JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf-8")).pid).toBe(
        4242,
      );

      release();
      expect(fsSync.existsSync(lockDir)).toBe(false);
    });
  });
});
