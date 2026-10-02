// Tests node process runner lifecycle and captured output.
import { spawnSync as realSpawnSync, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, onTestFinished, vi } from "vitest";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import {
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import {
  acquireRunNodeBuildLock,
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
} from "../../scripts/run-node.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  it,
  ROOT_SRC,
  ROOT_TSCONFIG,
  ROOT_PACKAGE,
  ROOT_TSDOWN,
  BUILD_STAMP,
  RUNTIME_POSTBUILD_STAMP,
  DIST_CHANNEL_CATALOG,
  QA_LAB_PLUGIN_SDK_ENTRY,
  QA_RUNTIME_PLUGIN_SDK_ENTRY,
  EXTENSION_SRC,
  EXTENSION_EXTRA_SRC,
  EXTENSION_MANIFEST,
  EXTENSION_PACKAGE,
  EXTENSION_README,
  DIST_EXTENSION_SRC,
  NEW_TIME,
  createExitedProcess,
  createPipedExitedProcess,
  createFakeProcess,
  skipRuntimePostBuild,
  firstMockCall,
  writeRuntimePostBuildScaffold,
  expectedBuildSpawn,
  statusCommandSpawn,
  resolvePath,
  isTsxScriptArgs,
  touchProjectFiles,
  setupTrackedProject,
  setupStampedProject,
  createSpawnRecorder,
  createCurrentGitSpawnRecorder,
  createBuildRequirementDeps,
  trackProjectWithGit,
  runNodeCommand,
  runStatusCommand,
  runQaCommand,
} from "../../test/scripts/run-node.test-support.js";

beforeEach(() => {
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
});

describe("run-node script", () => {
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

  it("starts the CLI only after the canonical runtime build completes", async ({ tmp }) => {
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
      env: { OPENCLAW_FORCE_BUILD: "1" },
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
      statusCommandSpawn(),
    ]);
    // The canonical profile owns metadata and both stamps; the local runner
    // only invokes postbuild directly on its separate metadata-only path.
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
    expect(fsSync.existsSync(lockDir)).toBe(false);
    expect(fakeProcess.listenerCount("exit")).toBe(0);
  });

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

  it("routes sync I/O trace stderr blocks to the output log without flooding stderr", async ({
    tmp,
  }) => {
    await setupTrackedProject(tmp);
    const outputPath = path.join(tmp, ".artifacts", "gateway-watch-profiles", "output.log");
    const childStderr = [
      "normal before\n",
      "(node:12345) WARNING: Detected use of sync API\n",
      "    at statSync (node:fs:1739:25)\n",
      "    at loadConfig (/repo/src/config.ts:1:1)\n",
      "\n",
      "normal after\n",
    ].join("");
    const spawn = (_cmd: string, args: string[]) =>
      createPipedExitedProcess({
        stderr: args[0] === "openclaw.mjs" ? childStderr : "",
      });
    const stderrChunks: string[] = [];
    const exitCode = await runNodeCommand(tmp, {
      env: {
        OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR: "1",
        OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
      },
      spawn,
      stderr: { write: (chunk) => stderrChunks.push(String(chunk)) },
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    const terminalStderr = stderrChunks.join("");
    expect(terminalStderr).toContain("normal before\n");
    expect(terminalStderr).toContain("normal after\n");
    expect(terminalStderr).not.toContain("Detected use of sync API");
    expect(terminalStderr).not.toContain("statSync");
    await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain(childStderr);
  });

  it.for([undefined, "/explicit/checkout"])(
    "carries the checkout selector into the CLI (override: %s)",
    async (override, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
      const { spawnSync } = createCurrentGitSpawnRecorder();
      let childEnv: NodeJS.ProcessEnv | undefined;
      const exitCode = await runNodeCommand(tmp, {
        env: { OPENCLAW_DEV_SOURCE_ROOT: override },
        spawn: (_cmd, _args, options) => {
          childEnv = options.env;
          return createExitedProcess(0);
        },
        spawnSync,
        runRuntimePostBuild: skipRuntimePostBuild,
      });
      expect(exitCode).toBe(0);
      expect(childEnv?.OPENCLAW_DEV_SOURCE_ROOT).toBe(override ?? tmp);
    },
  );

  it.for([
    { mode: "build", disable: undefined },
    { mode: "metadata", disable: "1" },
  ])(
    "carries private QA policy through $mode (disable: $disable)",
    async ({ mode, disable }, { tmp }) => {
      await setupStampedProject(tmp, {
        files: {
          [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n",
          ...(mode === "metadata"
            ? { [QA_RUNTIME_PLUGIN_SDK_ENTRY]: "export const qaRuntime = true;\n" }
            : {}),
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });
      const runRuntimePostBuild = vi.fn();
      const spawn = vi.fn((_cmd: string, _args: string[], _options: SpawnOptions) =>
        createExitedProcess(0),
      );
      const { spawnSync } = createCurrentGitSpawnRecorder();
      const exitCode = await runNodeCommand(tmp, {
        args: ["qa", "suite"],
        spawn,
        spawnSync,
        runRuntimePostBuild,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: disable },
      });
      expect(exitCode).toBe(0);
      expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
        ...(mode === "build" ? [expectedBuildSpawn().slice(1)] : []),
        ["openclaw.mjs", "qa", "suite"],
      ]);
      const expectedEnv = {
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: disable ?? "0",
      };
      for (const call of spawn.mock.calls) {
        expect(call[2].env).toMatchObject(expectedEnv);
      }
      if (mode === "metadata") {
        expect(runRuntimePostBuild).toHaveBeenCalledExactlyOnceWith({
          cwd: tmp,
          env: expect.objectContaining(expectedEnv),
        });
      } else {
        expect(runRuntimePostBuild).not.toHaveBeenCalled();
      }
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

  it.for([
    { platform: "win32", signal: "SIGKILL", expected: 1 },
    { platform: "win32", signal: "SIGTERM", expected: 143 },
  ] as const)(
    "maps child signals to Windows exit codes: %j",
    async ({ platform, signal, expected }, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
      for (const rebuild of [false, true]) {
        const spawn = vi.fn(() => createExitedProcess(null, signal));
        const outcome = await runNodeCommand(tmp, {
          env: { OPENCLAW_FORCE_BUILD: rebuild ? "1" : "0" },
          platform,
          spawn,
          runRuntimePostBuild: skipRuntimePostBuild,
        });
        expect(outcome).toBe(expected);
        expect(spawn).toHaveBeenCalledOnce();
      }
    },
  );

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
        env: { OPENCLAW_FORCE_BUILD: rebuild ? "1" : "0" },
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
    { source: "src/café.ts", target: "src/café.test.ts", watched: true },
    { source: "src/café.test.ts", target: "src/café.ts", watched: true },
  ])(
    "checks both rename sides with real Git: $source to $target",
    async ({ source, target, watched }, { tmp }) => {
      await setupStampedProject(tmp, { files: { [source]: "export {};\n" } });
      const { git, deps } = await trackProjectWithGit(tmp);
      git("config", "status.renames", "true");
      git("mv", "--", source, target);

      expect(resolveBuildRequirement(deps)).toEqual({
        shouldBuild: watched,
        reason: watched ? "dirty_watched_tree" : "clean",
      });
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
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    });
    const { promise: waitingForLock, resolve: markWaiting } = createDeferred();
    const stderr = {
      write: (chunk: string | Buffer) => {
        if (String(chunk).includes("Waiting for TypeScript/runtime artifact lock")) {
          markWaiting();
        }
        return true;
      },
    } as unknown as NodeJS.WriteStream;
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

  it.for([false, true])(
    "keeps legacy client stamps subject to required output checks (missing: %s)",
    async (missing, { tmp }) => {
      await setupStampedProject(tmp, {
        files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n' },
        trackConfig: true,
      });
      if (missing) {
        await fs.rm(resolvePath(tmp, DIST_CHANNEL_CATALOG));
      }
      const runRuntimePostBuild = vi.fn();
      const { spawn, spawnSync } = createCurrentGitSpawnRecorder();
      expect(
        await runStatusCommand({
          tmp,
          args: ["dashboard", "--no-open"],
          spawn,
          spawnSync,
          runRuntimePostBuild,
        }),
      ).toBe(0);
      expect(runRuntimePostBuild).toHaveBeenCalledTimes(missing ? 1 : 0);
    },
  );

  it.for(["build", "runtime"] as const)(
    "refreshes dirty-built %s artifacts after restoring the same HEAD source",
    async (scope, { tmp }) => {
      await setupStampedProject(tmp, {
        files: { "scripts/runtime-postbuild.mts": "export {};\n" },
        trackConfig: true,
      });
      const { git, deps } = await trackProjectWithGit(tmp);
      const needsRefresh = () =>
        scope === "build"
          ? resolveBuildRequirement(deps).shouldBuild
          : resolveRuntimePostBuildRequirement(deps).shouldSync;
      expect(needsRefresh()).toBe(false);
      const input = scope === "build" ? ROOT_SRC : "scripts/runtime-postbuild.mts";
      const original = await fs.readFile(resolvePath(tmp, input), "utf8");
      await fs.writeFile(resolvePath(tmp, input), `${original}\n`);
      expect(git("status", "--porcelain", "--", input)).not.toBe("");
      const stamp = scope === "build" ? writeBuildStamp : writeRuntimePostBuildStamp;
      stamp({ cwd: tmp, spawnSync: realSpawnSync });
      await fs.writeFile(resolvePath(tmp, input), original);
      expect(git("status", "--porcelain", "--", input)).toBe("");

      expect(needsRefresh()).toBe(true);
    },
  );

  it("ignores newer tracked config mtimes when Git proves the checkout is clean", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [ROOT_TSDOWN]: "export default {};\n" },
      oldPaths: [ROOT_SRC],
      newPaths: [ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
    });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it("uses newer config mtimes when Git state is unavailable", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      oldPaths: [ROOT_SRC],
      newPaths: [ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    const { spawnSync } = createSpawnRecorder();

    const requirement = resolveBuildRequirement({
      ...createBuildRequirementDeps(tmp),
      spawnSync,
    });

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "config_newer",
    });
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
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
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
