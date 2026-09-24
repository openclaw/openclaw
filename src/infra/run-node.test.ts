// Tests node process runner lifecycle and captured output.
import { spawnSync as realSpawnSync, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, vi } from "vitest";
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
  RUNTIME_POSTBUILD_IMPLEMENTATION_PATHS,
  GENERATED_PLUGIN_ASSET_BUNDLE,
  GENERATED_PLUGIN_ASSET_BUNDLE_HASH,
  DIST_ENTRY,
  BUILD_STAMP,
  RUNTIME_POSTBUILD_STAMP,
  DIST_PLUGIN_SDK_CORE,
  DIST_CHANNEL_CATALOG,
  DIST_BUILD_INFO,
  DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT,
  DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT,
  DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108,
  DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_2026_9_1,
  DIST_LEGACY_CLI_EXIT_COMPAT,
  DIST_LEGACY_CLI_EXIT_COMPAT_ALT,
  DIST_STABLE_ROOT_RUNTIME_SOURCE,
  DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT,
  DIST_STABLE_ROOT_RUNTIME_ALIAS,
  DIST_LEGACY_ROOT_RUNTIME_TARGET,
  DIST_LEGACY_ROOT_RUNTIME_COMPAT,
  QA_LAB_PLUGIN_SDK_ENTRY,
  QA_RUNTIME_PLUGIN_SDK_ENTRY,
  EXTENSION_INDEX,
  EXTENSION_SRC,
  EXTENSION_EXTRA_SRC,
  EXTENSION_SKILL,
  EXTENSION_MANIFEST,
  EXTENSION_PACKAGE,
  EXTENSION_README,
  DIST_EXTENSION_INDEX,
  DIST_EXTENSION_SRC,
  DIST_EXTENSION_SKILL,
  DIST_EXTENSION_RUNTIME_SRC,
  DIST_RUNTIME_EXTENSION_INDEX,
  DIST_RUNTIME_EXTENSION_MANIFEST,
  DIST_RUNTIME_EXTENSION_PACKAGE,
  DIST_RUNTIME_EXTENSION_SKILL,
  DIST_OPENCLAW_ALIAS_PACKAGE,
  DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE,
  DIST_OPENCLAW_ALIAS_PLUGIN_SDK_STRING_COERCE,
  DIFFS_PACKAGE,
  DIFFS_VIEWER_RUNTIME_SOURCE,
  DIST_DIFFS_VIEWER_RUNTIME,
  DIST_RUNTIME_DIFFS_VIEWER_RUNTIME,
  BUNDLED_HOOK_METADATA,
  DIST_BUNDLED_HOOK_METADATA,
  DIST_EXTENSION_MANIFEST,
  DIST_EXTENSION_PACKAGE,
  NEW_TIME,
  createExitedProcess,
  createPipedExitedProcess,
  createFakeProcess,
  skipRuntimePostBuild,
  syncBundledPluginMetadata,
  firstMockCall,
  writeRuntimePostBuildScaffold,
  expectedBuildSpawn,
  statusCommandSpawn,
  gatewayStatusCommandSpawn,
  resolvePath,
  isTsxScriptArgs,
  expectPathMissing,
  touchProjectFiles,
  setupTrackedProject,
  setupStampedProject,
  writeImmutableDeploymentManifest,
  createSpawnRecorder,
  createCurrentGitSpawnRecorder,
  createBuildRequirementDeps,
  trackProjectWithGit,
  runNodeCommand,
  runStatusCommand,
  runQaCommand,
  expectManifestId,
} from "../../test/scripts/run-node.test-support.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

describe("run-node script", () => {
  it.for([
    { args: ["qa", "mantis", "run"], mantis: true },
    { args: ["--dev", "qa", "mantis", "run"], mantis: true },
    { args: ["--profile", "ci", "qa", "mantis", "run"], mantis: true },
    { args: ["--profile=ci", "qa", "mantis", "run"], mantis: true },
    { args: ["--no-color", "--log-level", "debug", "qa", "mantis", "run"], mantis: true },
    { args: ["qa", "--profile", "ci", "mantis", "run"], mantis: true },
    { args: ["--profile", "qa", "mantis", "run"], mantis: false },
    { args: ["--profile", "ci", "qa", "suite"], mantis: false },
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
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("starts the CLI only after the canonical runtime build completes", async ({ tmp }) => {
    const build = new EventEmitter();
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
      env: { OPENCLAW_FORCE_BUILD: "1" },
      runRuntimePostBuild,
    });
    await Promise.race([buildSpawned, result]);
    expect(spawn).toHaveBeenCalledOnce();
    const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
    expect(fsSync.existsSync(lockDir)).toBe(true);
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
  });

  it.for([undefined, "0", "1"])(
    "defaults DTS off only for the canonical build child (override: %s)",
    async (skipDts, { tmp }) => {
      const spawnCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
      const spawn = (_cmd: string, args: string[], options: SpawnOptions) => {
        spawnCalls.push({ args, env: { ...options.env } });
        return createExitedProcess(0);
      };
      const exitCode = await runNodeCommand(tmp, {
        env: { OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: skipDts },
        spawn,
      });
      expect(exitCode).toBe(0);
      expect(spawnCalls.map(({ args }) => args)).toEqual([
        expectedBuildSpawn().slice(1),
        ["openclaw.mjs", "status"],
      ]);
      expect(spawnCalls[0]?.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts ?? "1");
      expect(spawnCalls[1]?.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts);
    },
  );

  it("tees launcher output into the requested generic output log", async ({ tmp }) => {
    await setupTrackedProject(tmp);
    const outputPath = path.join(tmp, ".artifacts", "qa-e2e", "matrix", "output.log");
    const spawnCalls: Array<{
      args: string[];
      env: Record<string, string | undefined>;
      stdio: unknown;
    }> = [];
    const spawn = (_cmd: string, args: string[], options?: unknown) => {
      const opts = options as { env?: NodeJS.ProcessEnv; stdio?: unknown } | undefined;
      spawnCalls.push({
        args,
        env: { ...opts?.env },
        stdio: opts?.stdio,
      });
      return createPipedExitedProcess({
        stdout: args[0] === "openclaw.mjs" ? "child stdout\n" : "",
        stderr: args[0] === "openclaw.mjs" ? "child stderr\n" : "",
      });
    };
    const mutedStream = {
      write: () => true,
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      env: {
        OPENCLAW_FORCE_BUILD: "1",
        OPENCLAW_RUNNER_LOG: "1",
        OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
      },
      spawn,
      stderr: mutedStream,
      stdout: mutedStream,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("child stdout\n");
    await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("child stderr\n");
    await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("[openclaw]");
    expect(spawnCalls.at(-1)?.args).toEqual(["openclaw.mjs", "status"]);
    expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_OUTPUT_LOG).toBe(outputPath);
    expect(spawnCalls.at(-1)?.stdio).toEqual(["inherit", "pipe", "pipe"]);
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
    const stderr = {
      write: (chunk: string | Buffer) => {
        stderrChunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      args: ["plugins", "list", "--json"],
      env: { OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath },
      spawn,
      stdout,
      stderr,
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
    const stderr = {
      write: (chunk: string | Buffer) => {
        stderrChunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const stdout = {
      write: () => true,
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      env: {
        OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR: "1",
        OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
      },
      spawn,
      stderr,
      stdout,
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

  it("adds Node CPU profiling flags to the launched OpenClaw child when requested", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
        [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
        [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
      },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    const profileDir = path.join(tmp, ".artifacts", "profiles");
    const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const spawn = (_cmd: string, args: string[], options?: unknown) => {
      const opts = options as { env?: NodeJS.ProcessEnv } | undefined;
      spawnCalls.push({ args, env: { ...opts?.env } });
      return createExitedProcess(0);
    };
    const { spawnSync } = createCurrentGitSpawnRecorder();

    const exitCode = await runNodeCommand(tmp, {
      env: { OPENCLAW_RUN_NODE_CPU_PROF_DIR: ".artifacts/profiles" },
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
      process: createFakeProcess(),
    });

    expect(exitCode).toBe(0);
    const childArgs = spawnCalls.at(-1)?.args ?? [];
    expect(childArgs[0]).toBe("--cpu-prof");
    expect(childArgs[1]).toBe(`--cpu-prof-dir=${profileDir}`);
    expect(childArgs[2]).toMatch(
      /^--cpu-prof-name=openclaw-status-4242-\d{4}-\d{2}-\d{2}T.*\.cpuprofile$/,
    );
    expect(childArgs.slice(3)).toEqual(["openclaw.mjs", "status"]);
    expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_CPU_PROF_DIR).toBe(profileDir);
    expect(fsSync.existsSync(profileDir)).toBe(true);
  });

  it("rotates old Node CPU profiles when a retention cap is set", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
    const profileDir = path.join(tmp, ".artifacts", "profiles");
    fsSync.mkdirSync(profileDir, { recursive: true });
    const oldProfiles = [
      "openclaw-status-oldest.cpuprofile",
      "openclaw-status-middle.cpuprofile",
      "openclaw-status-newest.cpuprofile",
    ];
    for (const [index, name] of oldProfiles.entries()) {
      const filePath = path.join(profileDir, name);
      fsSync.writeFileSync(filePath, "{}");
      const mtime = new Date(1_700_000_000_000 + index * 1000);
      fsSync.utimesSync(filePath, mtime, mtime);
    }
    fsSync.writeFileSync(path.join(profileDir, "openclaw-models-old.cpuprofile"), "{}");

    const spawn = () => createExitedProcess(0);
    const { spawnSync } = createCurrentGitSpawnRecorder();

    const exitCode = await runNodeCommand(tmp, {
      env: {
        OPENCLAW_RUN_NODE_CPU_PROF_DIR: ".artifacts/profiles",
        OPENCLAW_RUN_NODE_CPU_PROF_MAX_FILES: "2",
      },
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
      process: createFakeProcess(),
    });

    expect(exitCode).toBe(0);
    expect(
      fsSync.existsSync(
        path.join(profileDir, expectDefined(oldProfiles[0], "oldProfiles[0] test invariant")),
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        path.join(profileDir, expectDefined(oldProfiles[1], "oldProfiles[1] test invariant")),
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        path.join(profileDir, expectDefined(oldProfiles[2], "oldProfiles[2] test invariant")),
      ),
    ).toBe(true);
    expect(fsSync.existsSync(path.join(profileDir, "openclaw-models-old.cpuprofile"))).toBe(true);
  });

  it("adds Node sync I/O tracing flag to the launched OpenClaw child when requested", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
    const spawnCalls: string[][] = [];
    const spawn = (_cmd: string, args: string[]) => {
      spawnCalls.push(args);
      return createExitedProcess(0);
    };
    const { spawnSync } = createCurrentGitSpawnRecorder();

    const exitCode = await runNodeCommand(tmp, {
      args: ["gateway", "--force"],
      env: { OPENCLAW_TRACE_SYNC_IO: "1" },
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls.at(-1)).toEqual(["--trace-sync-io", "openclaw.mjs", "gateway", "--force"]);
  });

  it("surfaces generic output log stream errors", async ({ tmp }) => {
    await setupTrackedProject(tmp);
    const outputPath = path.join(tmp, ".artifacts", "qa-e2e", "matrix", "output.log");
    await fs.mkdir(outputPath, { recursive: true });
    const spawn = () => createPipedExitedProcess({ stdout: "child stdout\n" });
    const stderrChunks: string[] = [];
    const mutedStream = {
      write: (chunk: string | Buffer) => {
        stderrChunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      env: { OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath },
      spawn,
      stderr: mutedStream,
      stdout: mutedStream,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain("Failed to write output log");
  });

  it("does not mutate Matrix QA args when no generic output log is requested", async ({ tmp }) => {
    await setupTrackedProject(tmp);
    const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const spawn = (_cmd: string, args: string[], options?: unknown) => {
      const opts = options as { env?: NodeJS.ProcessEnv } | undefined;
      spawnCalls.push({ args, env: { ...opts?.env } });
      return createPipedExitedProcess({});
    };
    const mutedStream = {
      write: () => true,
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      args: ["qa", "matrix"],
      spawn,
      stderr: mutedStream,
      stdout: mutedStream,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    const childArgs = spawnCalls.at(-1)?.args ?? [];
    expect(childArgs).toEqual(["openclaw.mjs", "qa", "matrix"]);
    expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_OUTPUT_LOG).toBeUndefined();
  });

  it("skips rebuilding when dist is current and the source tree is clean", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
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

  it("skips rebuilding for private QA commands when the private QA facades are present", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n",
        [QA_RUNTIME_PLUGIN_SDK_ENTRY]: "export const qaRuntime = true;\n",
      },
      oldPaths: [
        ROOT_SRC,
        ROOT_TSCONFIG,
        ROOT_PACKAGE,
        QA_LAB_PLUGIN_SDK_ENTRY,
        QA_RUNTIME_PLUGIN_SDK_ENTRY,
      ],
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runQaCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([
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

  it("rebuilds private QA commands when the private QA runtime facade is missing", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n" },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, QA_LAB_PLUGIN_SDK_ENTRY],
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
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
    { mode: "build", disable: undefined },
    { mode: "build", disable: "1" },
    { mode: "metadata", disable: undefined },
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

  it("derives private QA facade checks from distRoot for direct freshness checks", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n" },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, QA_LAB_PLUGIN_SDK_ENTRY],
    });

    const requirement = resolveBuildRequirement(
      createBuildRequirementDeps(tmp, { env: { OPENCLAW_BUILD_PRIVATE_QA: "1" } }),
    );

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "missing_private_qa_dist",
    });
  });

  it("skips runtime postbuild restaging in watch mode when dist is already current", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it("reruns runtime postbuild in watch mode when required outputs are missing with no runtime stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
        [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
      },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    await fs.rm(resolvePath(tmp, DIST_OPENCLAW_ALIAS_PACKAGE));

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  it("reruns runtime postbuild for dirty extension package metadata in watch mode", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.ts"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
      trackConfig: true,
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_PACKAGE}\0`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  for (const { title, command, reportScript, reportArgs } of [
    {
      title: "runs QA parity report from source without rebuilding private QA dist",
      command: "parity-report",
      reportScript: "qa-parity-report.ts",
      reportArgs: [
        "--candidate-summary",
        ".artifacts/qa-e2e/openai-candidate/qa-suite-summary.json",
        "--baseline-summary",
        ".artifacts/qa-e2e/anthropic-baseline/qa-suite-summary.json",
      ],
    },
    {
      title: "runs QA coverage report from source without rebuilding private QA dist",
      command: "coverage",
      reportScript: "qa-coverage-report.ts",
      reportArgs: [
        "--json",
        "--tools",
        "--summary",
        ".artifacts/qa-e2e/runtime-pair-core/qa-suite-summary.json",
      ],
    },
  ]) {
    it(title, async ({ tmp }) => {
      await setupTrackedProject(tmp, {
        files: { "extensions/qa-lab/src/cli.runtime.ts": "export {};\n" },
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });
      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };
      const exitCode = await runNodeCommand(tmp, {
        args: ["qa", command, ...reportArgs],
        spawn,
      });
      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        [
          process.execPath,
          "--import",
          "tsx",
          path.join(tmp, "scripts", reportScript),
          ...reportArgs,
        ],
      ]);
    });
  }

  it("skips runtime postbuild restaging when the runtime stamp is current", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it("runs current immutable deployment artifacts without refreshing them", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    await writeImmutableDeploymentManifest(tmp);

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      args: ["gateway", "status", "--deep", "--require-rpc", "--json"],
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([gatewayStatusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  for (const { label, missingPath, expectedReason } of [
    {
      label: "build output",
      missingPath: BUILD_STAMP,
      expectedReason: "build stamp missing",
    },
    {
      label: "runtime postbuild output",
      missingPath: DIST_OPENCLAW_ALIAS_PACKAGE,
      expectedReason: "required runtime postbuild output missing",
    },
  ]) {
    it(`refuses to regenerate missing ${label} in an immutable deployment`, async ({ tmp }) => {
      await setupStampedProject(tmp, {
        files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });
      await writeImmutableDeploymentManifest(tmp);
      await fs.rm(resolvePath(tmp, missingPath));

      const stderrChunks: string[] = [];
      const stderr = {
        write: (chunk: string | Buffer) => {
          stderrChunks.push(String(chunk));
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
      const exitCode = await runStatusCommand({
        tmp,
        args: ["gateway", "status", "--deep", "--require-rpc", "--json"],
        spawn,
        spawnSync,
        stderr,
        runRuntimePostBuild,
      });

      expect(exitCode).toBe(1);
      expect(spawnCalls).toEqual([]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
      expect(stderrChunks.join("")).toContain(expectedReason);
      expect(stderrChunks.join("")).toContain("node openclaw.mjs");
    });
  }

  it("restages runtime artifacts when runtime metadata is dirty", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
      trackConfig: true,
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_MANIFEST}\0`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  it.for(["stamp", "overlay"])(
    "serializes concurrent runtime restaging with a missing %s",
    async (missing, { tmp }) => {
      await setupStampedProject(tmp, {
        files:
          missing === "overlay"
            ? {
                [DIST_EXTENSION_INDEX]: "export default {};\n",
                [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
              }
            : {},
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });

      let markPostbuildStarted!: () => void;
      let releasePostbuild!: () => void;
      const postbuildStarted = new Promise<void>((resolve) => {
        markPostbuildStarted = resolve;
      });
      const postbuildRelease = new Promise<void>((resolve) => {
        releasePostbuild = resolve;
      });
      const { promise: waitingForLock, resolve: markWaiting } = createDeferred();
      const runRuntimePostBuild = vi.fn(async () => {
        markPostbuildStarted();
        await postbuildRelease;
        if (missing === "overlay") {
          const runtimePath = resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX);
          await fs.mkdir(path.dirname(runtimePath), { recursive: true });
          await fs.copyFile(resolvePath(tmp, DIST_EXTENSION_INDEX), runtimePath);
        }
      });
      const { spawn, spawnSync } = createCurrentGitSpawnRecorder();

      const options = {
        spawn,
        spawnSync,
        env: {
          OPENCLAW_RUNNER_LOG: "1",
          OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "1",
        },
        stderr: {
          write: (chunk: string | Uint8Array) => {
            if (String(chunk).includes("Waiting for TypeScript/runtime artifact lock")) {
              markWaiting();
            }
            return true;
          },
        },
        runRuntimePostBuild,
      };
      const runs = Promise.all([runNodeCommand(tmp, options), runNodeCommand(tmp, options)]);

      await postbuildStarted;
      await waitingForLock;
      releasePostbuild();
      await expect(runs).resolves.toEqual([0, 0]);

      expect(runRuntimePostBuild).toHaveBeenCalledTimes(1);
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
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
        return {
          on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
            events.on(event, cb);
            return undefined;
          },
        };
      }
      return createExitedProcess(0);
    });

    const exitCode = await runNodeCommand(tmp, { env: { OPENCLAW_FORCE_BUILD: "1" }, spawn });

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
  });

  it.for([
    { platform: "linux", signal: "SIGKILL", expected: "SIGKILL" },
    { platform: "linux", signal: "SIGTERM", expected: "SIGTERM" },
    { platform: "win32", signal: "SIGKILL", expected: 1 },
    { platform: "win32", signal: "SIGTERM", expected: 143 },
  ] as const)(
    "preserves child signal outcomes without changing Windows exits: %j",
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

  it.for([false, true])(
    "forwards SIGTERM to the active child and returns 143 (rebuild: %s)",
    async (rebuild, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

      const fakeProcess = Object.assign(createFakeProcess(), {
        stdin: {
          isTTY: true,
        },
      });
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn((_signal: string) => {
          queueMicrotask(() => child.emit("exit", 0, null));
          return true;
        }),
      });
      const { promise: childSpawned, resolve: markChildSpawned } = createDeferred();
      const spawn = vi.fn((_cmd: string, _args: string[], _options: SpawnOptions) => {
        markChildSpawned();
        return child;
      });

      const exitCodePromise = runNodeCommand(tmp, {
        env: { OPENCLAW_FORCE_BUILD: rebuild ? "1" : "0" },
        process: fakeProcess,
        spawn,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      await Promise.race([childSpawned, exitCodePromise]);
      expect(spawn).toHaveBeenCalled();
      fakeProcess.emit("SIGTERM");
      const exitCode = await exitCodePromise;

      expect(exitCode).toBe(143);
      expect(spawn).toHaveBeenCalledTimes(1);
      const spawnCall = firstMockCall(spawn) as [string, string[], { stdio?: unknown }] | undefined;
      expect(spawnCall?.[0]).toBe(process.execPath);
      expect(spawnCall?.[1]).toEqual(
        rebuild ? expectedBuildSpawn().slice(1) : ["openclaw.mjs", "status"],
      );
      expect(spawnCall?.[2].stdio).toEqual(rebuild ? ["inherit", "pipe", "pipe"] : "inherit");
      expect(spawnCall?.[2]).toMatchObject({ detached: false });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32").for([false, true])(
    "force-cleans the active child process group after SIGTERM (rebuild: %s)",
    async (rebuild, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

      const fakeProcess = Object.assign(createFakeProcess(), {
        stdin: {
          isTTY: false,
        },
      });
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
      const spawnCall = firstMockCall(spawn) as
        | [string, string[], { detached?: boolean; stdio?: unknown }]
        | undefined;
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

  it("rebuilds when extension sources are newer than the build stamp", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export const extensionValue = 1;\n",
      },
      newPaths: [EXTENSION_SRC],
      rootSource: false,
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
  });

  it("shows tty progress while rebuilding source-checkout artifacts", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
    const { spawn, spawnSync } = createSpawnRecorder();
    const stderrChunks: string[] = [];
    const stderr = {
      isTTY: true,
      write: vi.fn((chunk: string | Buffer) => {
        stderrChunks.push(String(chunk));
        return true;
      }),
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      env: { CI: "false", OPENCLAW_FORCE_BUILD: "1" },
      spawn,
      spawnSync,
      stderr,
      runRuntimePostBuild: async () => {},
    });

    expect(exitCode).toBe(0);
    const stderrText = stderrChunks.join("");
    expect(stderrText).toContain("Building local CLI artifacts");
    expect(stderrText).toContain("\x1b[2K");
  });

  it("rebuilds when git HEAD changes even if source mtimes do not exceed the old build stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({ gitHead: "def456\n" });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
  });

  it("skips rebuilding when extension package metadata is newer than the build stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"name":"demo","openclaw":{"extensions":["./index.ts"]}}\n',
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_PACKAGE]: '{"name":"demo","openclaw":{"extensions":["./stale.js"]}}\n',
      },
      oldPaths: [EXTENSION_INDEX, EXTENSION_MANIFEST, ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
      newPaths: [EXTENSION_PACKAGE],
      rootSource: false,
    });

    const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expect(fs.readFile(resolvePath(tmp, DIST_EXTENSION_PACKAGE), "utf-8")).resolves.toContain(
      '"./index.js"',
    );
  });

  it("skips rebuilding for dirty non-source files under extensions", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [EXTENSION_README]: "# demo\n", [ROOT_TSDOWN]: "export default {};\n" },
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_README}\0`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
  });

  it("skips rebuilding for dirty extension manifests that only affect runtime reload", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"stale","configSchema":{"type":"object"}}\n',
      },
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_MANIFEST}\0`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expectManifestId(tmp, DIST_EXTENSION_MANIFEST, "demo");
  });

  it.for([
    { filePath: ROOT_SRC, watched: true },
    { filePath: "src/café.ts", watched: true },
    { filePath: "extensions/demo/src/café.ts", watched: true },
    { filePath: "src/café.test.ts", watched: false },
    { filePath: "src/..ignored.test.ts", watched: false },
    ...(process.platform === "win32"
      ? []
      : [
          { filePath: "src/left -> right.ts", watched: true },
          { filePath: 'src/"quoted".ts', watched: true },
          { filePath: "src/tab\tname.ts", watched: true },
          { filePath: "src/line\nname.ts", watched: true },
          { filePath: "src/ignored.test.ts ", watched: true },
          { filePath: "src/name\\part.ts", watched: true },
          { filePath: "src/name\\part.test.ts", watched: false },
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
    { source: "src/café.test.ts", target: "src/renamed.test.ts", watched: false },
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

  it.each([
    { label: "gateway RPC", args: ["gateway", "call", "status", "--json"] },
    { label: "gateway status", args: ["gateway", "status", "--json"] },
    { label: "remote agent", args: ["agent", "--message", "hello"] },
    { label: "dashboard", args: ["dashboard", "--no-open", "--yes"] },
  ])("does not rebuild for $label calls against an existing dirty dist", async ({ args }) => {
    await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupStampedProject(tmp, {
        files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
        trackConfig: true,
      });

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
        gitStatus: ` M ${ROOT_SRC}\0`,
      });
      const exitCode = await runStatusCommand({
        tmp,
        args,
        spawn,
        spawnSync,
        runRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([[process.execPath, "openclaw.mjs", ...args]]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
    });
  });

  it("rechecks a dirty dashboard client after waiting for an active build", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      trackConfig: true,
    });
    await fs.rm(resolvePath(tmp, BUILD_STAMP));
    await fs.rm(resolvePath(tmp, RUNTIME_POSTBUILD_STAMP));

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
    await fs.writeFile(
      resolvePath(tmp, BUILD_STAMP),
      '{"head":"abc123","inputsClean":true}\n',
      "utf-8",
    );
    await fs.writeFile(
      resolvePath(tmp, RUNTIME_POSTBUILD_STAMP),
      '{"head":"abc123","inputsClean":true}\n',
      "utf-8",
    );
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

  it("reports a clean tree explicitly when dist is current", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

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

  it("reports clean in sparse worktrees without bundled plugin sources", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
    await fs.rm(resolvePath(tmp, "extensions"), { recursive: true, force: true });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it("rebuilds when dirty bundled package entries point at missing dist outputs", async ({
    tmp,
  }) => {
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

    const requirement = resolveBuildRequirement(
      createBuildRequirementDeps(tmp, { gitStatus: ` M ${EXTENSION_PACKAGE}\0` }),
    );

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "dirty_watched_tree",
    });
  });

  it("rebuilds when clean bundled plugin dist outputs are partially missing", async ({ tmp }) => {
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

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "missing_bundled_plugin_dist_entry",
    });
  });

  it("rebuilds when a clean stamped bundled plugin dist directory is missing", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts"]}}\n',
      },
      trackConfig: true,
    });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "missing_bundled_plugin_dist_entry",
    });
  });

  it("reports clean runtime postbuild artifacts when the runtime stamp matches HEAD", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing runtime postbuild outputs even when stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts"]}}\n',
        [DIST_EXTENSION_SRC]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.js"]}}\n',
        [DIST_EXTENSION_RUNTIME_SRC]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });
    await fs.rm(resolvePath(tmp, DIST_EXTENSION_PACKAGE));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("restages missing runtime overlays from restored dist without plugin sources", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });
    await fs.rm(resolvePath(tmp, "extensions"), { recursive: true, force: true });
    await fs.rm(resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX));

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const runRuntimePostBuild = vi.fn(async () => {
      await fs.copyFile(
        resolvePath(tmp, DIST_EXTENSION_INDEX),
        resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX),
      );
    });
    const exitCode = await runStatusCommand({ tmp, spawn, spawnSync, runRuntimePostBuild });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
    await expect(fs.readFile(resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX), "utf8")).resolves.toBe(
      "export default {};\n",
    );
  });

  it("does not require OpenClaw SDK alias outputs when dist extensions are absent", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
        [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
        [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
        [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });
    await fs.rm(path.join(tmp, "dist", "extensions"), { recursive: true, force: true });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing OpenClaw SDK alias outputs when runtime stamps match HEAD", async ({
    tmp,
  }) => {
    await setupTrackedProject(tmp, {
      files: {
        [ROOT_SRC]: "export const value = 1;\n",
        [ROOT_PACKAGE]:
          '{"name":"openclaw-test","exports":{"./plugin-sdk/core":"./dist/plugin-sdk/core.js"}}\n',
        [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
        [DIST_OPENCLAW_ALIAS_PACKAGE]:
          '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/core":"./plugin-sdk/core.js"}}\n',
        [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE]: "export * from '../../../../plugin-sdk/core.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
      buildPaths: [
        ROOT_SRC,
        DIST_ENTRY,
        DIST_PLUGIN_SDK_CORE,
        DIST_OPENCLAW_ALIAS_PACKAGE,
        DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE,
        BUILD_STAMP,
        RUNTIME_POSTBUILD_STAMP,
      ],
    });
    await fs.rm(resolvePath(tmp, DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("does not require private OpenClaw SDK dist files that package exports omit", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [ROOT_PACKAGE]: JSON.stringify(
          {
            name: "openclaw-test",
            exports: {
              "./plugin-sdk/string-coerce-runtime": "./dist/plugin-sdk/string-coerce-runtime.js",
            },
          },
          null,
          2,
        ),
        "dist/plugin-sdk/string-coerce-runtime.js": "export const publicRuntime = true;\n",
        "dist/plugin-sdk/ssrf-runtime-internal.js": "export const internal = true;\n",
        [DIST_OPENCLAW_ALIAS_PACKAGE]:
          '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/string-coerce-runtime":"./plugin-sdk/string-coerce-runtime.js"}}\n',
        [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_STRING_COERCE]:
          "export * from '../../../../plugin-sdk/string-coerce-runtime.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  for (const [title, missingPath] of [
    [
      "reports missing static runtime postbuild asset outputs when runtime stamps match HEAD",
      DIST_DIFFS_VIEWER_RUNTIME,
    ],
    [
      "reports missing static runtime overlay asset outputs when runtime stamps match HEAD",
      DIST_RUNTIME_DIFFS_VIEWER_RUNTIME,
    ],
  ] as const) {
    it(title, async ({ tmp }) => {
      await setupStampedProject(tmp, {
        files: {
          [DIFFS_PACKAGE]:
            '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
          [DIFFS_VIEWER_RUNTIME_SOURCE]: "export {};\n",
          [DIST_DIFFS_VIEWER_RUNTIME]: "export {};\n",
          [DIST_RUNTIME_DIFFS_VIEWER_RUNTIME]: "export {};\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
        },
      });
      await fs.rm(resolvePath(tmp, missingPath));
      const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));
      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
    });
  }

  it("does not require static asset outputs when runtime static assets are disabled", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIFFS_PACKAGE]:
          '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
        [DIFFS_VIEWER_RUNTIME_SOURCE]: "export {};\n",
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(
      createBuildRequirementDeps(tmp, { env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" } }),
    );

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("does not require static asset outputs when the declared source is absent", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIFFS_PACKAGE]:
          '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing core runtime postbuild outputs when runtime stamps match HEAD", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_STABLE_ROOT_RUNTIME_SOURCE]: "export const value = 1;\n",
        [DIST_STABLE_ROOT_RUNTIME_ALIAS]: "export * from './model-catalog.runtime-AbCd1234.js';\n",
        [DIST_LEGACY_ROOT_RUNTIME_TARGET]: "export const aborted = true;\n",
        [DIST_LEGACY_ROOT_RUNTIME_COMPAT]: "export * from './abort.runtime.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    for (const missingPath of [
      DIST_CHANNEL_CATALOG,
      DIST_BUILD_INFO,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_2026_9_1,
      DIST_LEGACY_CLI_EXIT_COMPAT,
      DIST_STABLE_ROOT_RUNTIME_ALIAS,
      DIST_LEGACY_ROOT_RUNTIME_COMPAT,
    ]) {
      const resolvedMissingPath = resolvePath(tmp, missingPath);
      const originalContent = await fs.readFile(resolvedMissingPath, "utf8");
      await fs.rm(resolvedMissingPath);
      const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
      await fs.writeFile(resolvedMissingPath, originalContent);
    }
  });

  it("reports missing bundled hook metadata when runtime stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [BUNDLED_HOOK_METADATA]: "# Demo hook\n",
        [DIST_BUNDLED_HOOK_METADATA]: "# Demo hook\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    expect(resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp))).toEqual({
      shouldSync: false,
      reason: "clean",
    });
    await fs.rm(resolvePath(tmp, DIST_BUNDLED_HOOK_METADATA));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("does not require ambiguous stable runtime aliases that postbuild cannot create", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_STABLE_ROOT_RUNTIME_SOURCE]: "export const value = 1;\n",
        [DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT]: "export const value = 2;\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing runtime skill outputs even when stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [EXTENSION_SKILL]: "# Demo\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [DIST_EXTENSION_SKILL]: "# Demo\n",
        [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [DIST_RUNTIME_EXTENSION_SKILL]: "# Demo\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });
    await fs.rm(resolvePath(tmp, DIST_RUNTIME_EXTENSION_SKILL));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("reports dirty runtime postbuild inputs separately from rebuild inputs", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
        [DIST_EXTENSION_INDEX]: "export default {};\n",
      },
      trackConfig: true,
    });

    const deps = createBuildRequirementDeps(tmp, { gitStatus: ` M ${EXTENSION_MANIFEST}\0` });

    expect(resolveBuildRequirement(deps)).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
    expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
      shouldSync: true,
      reason: "dirty_runtime_postbuild_inputs",
    });
  });

  it.each(RUNTIME_POSTBUILD_IMPLEMENTATION_PATHS)(
    "reports dirty runtime postbuild implementation %s",
    async (implementationPath) => {
      await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        await setupStampedProject(tmp, {
          files: {
            [implementationPath]: "export {};\n",
            [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
          },
          trackConfig: true,
        });

        const requirement = resolveRuntimePostBuildRequirement(
          createBuildRequirementDeps(tmp, { gitStatus: ` M ${implementationPath}\0` }),
        );

        expect(requirement).toEqual({
          shouldSync: true,
          reason: "dirty_runtime_postbuild_inputs",
        });
      });
    },
  );

  it("reports a newer hook metadata copier without git status", async ({ tmp }) => {
    const implementationPath = "scripts/copy-hook-metadata.ts";
    await setupStampedProject(tmp, {
      files: {
        [implementationPath]: "export {};\n",
        [RUNTIME_POSTBUILD_STAMP]: "{}\n",
      },
      newPaths: [implementationPath],
      trackConfig: true,
    });
    const deps = createBuildRequirementDeps(tmp);
    deps.spawnSync = () => ({ status: 1, stdout: "" });

    expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
      shouldSync: true,
      reason: "runtime_postbuild_input_mtime_newer",
    });
  });

  it("ignores dirty generated plugin bundle artifacts when dist is current", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const requirement = resolveBuildRequirement(
      createBuildRequirementDeps(tmp, {
        gitStatus: ` M ${GENERATED_PLUGIN_ASSET_BUNDLE_HASH}\0 M ${GENERATED_PLUGIN_ASSET_BUNDLE}\0`,
      }),
    );

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it.for([
    { label: "SKILL.md", fileName: "SKILL.md", changedFile: null, shouldSync: true },
    { label: "café.md", fileName: "café.md", changedFile: null, shouldSync: true },
    ...(process.platform === "win32"
      ? []
      : [
          {
            label: "POSIX backslash inside declared skills",
            fileName: "notes\\part.md",
            changedFile: null,
            shouldSync: true,
          },
          {
            label: "POSIX backslash outside declared skills",
            fileName: "SKILL.md",
            changedFile: "skills\\notes.md",
            shouldSync: false,
          },
        ]),
  ])(
    "reports bundled skill edits as runtime postbuild inputs: $label",
    async ({ fileName, changedFile, shouldSync }, { tmp }) => {
      const skillPath = bundledPluginFile("demo", `skills/${fileName}`);
      const changedPath = changedFile ? bundledPluginFile("demo", changedFile) : skillPath;
      const manifest = JSON.stringify({ id: "demo", skills: ["./skills"] });
      await setupStampedProject(tmp, {
        files: {
          [EXTENSION_INDEX]: "export default {};\n",
          [EXTENSION_MANIFEST]: manifest,
          [skillPath]: "# Demo\n",
          [DIST_EXTENSION_INDEX]: "export default {};\n",
          [DIST_EXTENSION_MANIFEST]: manifest,
          [bundledDistPluginFile("demo", `skills/${fileName}`)]: "# Demo\n",
          [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
          [DIST_RUNTIME_EXTENSION_MANIFEST]: manifest,
          [`dist-runtime/extensions/demo/skills/${fileName}`]: "# Demo\n",
          ...(changedFile ? { [changedPath]: "# Notes\n" } : {}),
        },
        trackConfig: true,
      });
      const { deps } = await trackProjectWithGit(tmp);
      expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
        shouldSync: false,
        reason: "clean",
      });

      await fs.writeFile(resolvePath(tmp, changedPath), "# Updated\n");
      await touchProjectFiles(tmp, [changedPath], NEW_TIME);
      expect(resolveBuildRequirement(deps)).toEqual({ shouldBuild: false, reason: "clean" });
      expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
        shouldSync,
        reason: shouldSync ? "dirty_runtime_postbuild_inputs" : "clean",
      });
    },
  );

  it("repairs missing bundled plugin metadata without rerunning tsdown", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
      },
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expectManifestId(tmp, DIST_EXTENSION_MANIFEST, "demo");
  });

  it("removes stale bundled plugin metadata when the source manifest is gone", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"stale","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"name":"stale"}\n',
      },
      trackConfig: true,
    });

    await fs.mkdir(resolvePath(tmp, bundledPluginRoot("demo")), { recursive: true });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expectPathMissing(resolvePath(tmp, DIST_EXTENSION_MANIFEST));
    await expectPathMissing(resolvePath(tmp, DIST_EXTENSION_PACKAGE));
  });

  it("skips rebuilding when only non-source extension files are newer than the build stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [EXTENSION_README]: "# demo\n", [ROOT_TSDOWN]: "export default {};\n" },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
      newPaths: [EXTENSION_README],
    });

    const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
  });

  it("rebuilds when tsdown config is dirty", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [ROOT_TSDOWN]: "export default {};\n" },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      newPaths: [ROOT_TSDOWN],
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${ROOT_TSDOWN}\0`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
  });

  describe("acquireRunNodeBuildLock", () => {
    const lockDeps = (tmp: string, fakeProcess: NodeJS.Process) => ({
      cwd: tmp,
      args: ["status"],
      env: { OPENCLAW_RUNNER_LOG: "0" },
      fs: fsSync,
      process: fakeProcess,
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    });

    it("releases the lock directory when the wrapper receives SIGINT", async ({ tmp }) => {
      const fakeProcess = createFakeProcess();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fsSync.existsSync(lockDir)).toBe(true);

      fakeProcess.emit("SIGINT");
      expect(fsSync.existsSync(lockDir)).toBe(false);

      // Normal release after signal must be a no-op.
      expect(release()).toBeUndefined();
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
      expect(fakeProcess.listenerCount("exit")).toBe(0);
    });

    it("releases the lock directory when the wrapper receives SIGTERM", async ({ tmp }) => {
      const fakeProcess = createFakeProcess();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fsSync.existsSync(lockDir)).toBe(true);

      fakeProcess.emit("SIGTERM");
      expect(fsSync.existsSync(lockDir)).toBe(false);
      expect(release()).toBeUndefined();
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

    it("detaches signal listeners after a normal release", async ({ tmp }) => {
      const fakeProcess = createFakeProcess();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fakeProcess.listenerCount("SIGINT")).toBe(1);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(1);
      expect(fakeProcess.listenerCount("exit")).toBe(1);

      release();
      expect(fsSync.existsSync(lockDir)).toBe(false);
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
      expect(fakeProcess.listenerCount("exit")).toBe(0);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
