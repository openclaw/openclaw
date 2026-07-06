// Tests watched node process restart and hashing behavior.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
  runNodeWatchedPaths,
} from "../../scripts/run-node.mjs";
import { runWatchMain } from "../../scripts/watch-node.mjs";
import { withTempDir } from "../test-helpers/temp-dir.js";

vi.mock("../../scripts/run-node.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/run-node.mjs")>();
  return {
    ...actual,
    resolveBuildRequirement: vi.fn(() => ({ shouldBuild: false, reason: "clean" })),
    resolveRuntimePostBuildRequirement: vi.fn(() => ({ shouldSync: false, reason: "clean" })),
  };
});

const VOICE_CALL_README = bundledPluginFile("voice-call", "README.md");
const VOICE_CALL_MANIFEST = bundledPluginFile("voice-call", "openclaw.plugin.json");
const VOICE_CALL_PACKAGE = bundledPluginFile("voice-call", "package.json");
const VOICE_CALL_INDEX = bundledPluginFile("voice-call", "index.ts");
const VOICE_CALL_RUNTIME = bundledPluginFile("voice-call", "src/runtime.ts");
type WatchRunParams = NonNullable<Parameters<typeof runWatchMain>[0]> & {
  lockDisabled?: boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
};

const runWatch = (params: WatchRunParams) => runWatchMain(params);
const resolveTestWatchLockPath = (cwd: string, args: string[]) =>
  path.join(
    cwd,
    ".local",
    "watch-node",
    `${createHash("sha256").update(cwd).update("\0").update(args.join("\0")).digest("hex").slice(0, 12)}.json`,
  );

const createFakeProcess = () =>
  Object.assign(new EventEmitter(), {
    pid: 4242,
    execPath: "/usr/local/bin/node",
  }) as unknown as NodeJS.Process;

const createKillableChild = () => {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
  });
  child.kill.mockImplementation((signal: NodeJS.Signals = "SIGTERM") => {
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  });
  return child;
};

const createWatchHarness = () => {
  const child = createKillableChild();
  const spawn = vi.fn(() => child);
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
  });
  const createWatcher = vi.fn(() => watcher);
  const fakeProcess = createFakeProcess();
  return { child, spawn, watcher, createWatcher, fakeProcess };
};

const createAutoExitChild = () => {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
  });
  child.kill.mockImplementation(() => {
    queueMicrotask(() => child.emit("exit", 0, null));
  });
  return child;
};

const startWatchRun = ({
  args = ["gateway", "--force"],
  env,
  spawn,
}: {
  args?: string[];
  env?: WatchRunParams["env"];
  spawn: NonNullable<WatchRunParams["spawn"]>;
}) => {
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
  });
  const createWatcher = vi.fn(() => watcher);
  const fakeProcess = createFakeProcess();
  const runPromise = runWatch({
    args,
    createWatcher,
    // Default to test mode to skip dist/entry.js checks in tests
    env: env ? { ...env, OPENCLAW_WATCH_MODE: "test" } : { OPENCLAW_WATCH_MODE: "test" },
    lockDisabled: true,
    process: fakeProcess,
    spawn,
  });
  return { watcher, createWatcher, fakeProcess, runPromise };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireMockCall(mock: ReturnType<typeof vi.fn>, callIndex: number): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

function requireSpawnOptions(spawn: ReturnType<typeof vi.fn>, callIndex: number) {
  return requireRecord(requireMockCall(spawn, callIndex)[2], "spawn options");
}

function requireSpawnEnv(spawn: ReturnType<typeof vi.fn>, callIndex: number) {
  return requireRecord(requireSpawnOptions(spawn, callIndex).env, "spawn env");
}

describe("watch-node script", () => {
  it("wires chokidar watch to run-node with watched source/config paths", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();
    await withTempDir({ prefix: "openclaw-watch-node-" }, async (cwd) => {
      fs.mkdirSync(path.join(cwd, "src", "infra"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "extensions", "voice-call"), { recursive: true });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd,
        createWatcher,
        env: { PATH: "/usr/bin" },
        lockDisabled: true,
        now: () => 1700000000000,
        process: fakeProcess,
        spawn,
      });

      expect(createWatcher).toHaveBeenCalledTimes(1);
      const [watchPaths, watchOptions] = requireMockCall(createWatcher, 0) as unknown as [
        string[],
        { ignoreInitial: boolean; ignored: (watchPath: string) => boolean },
      ];
      expect(watchPaths).toEqual(runNodeWatchedPaths);
      expect(watchPaths).toContain("extensions");
      expect(watchPaths).toContain("packages/gateway-client/src");
      expect(watchPaths).toContain("packages/gateway-protocol/src");
      expect(watchPaths).toContain("packages/markdown-core/src");
      expect(watchPaths).toContain("packages/media-core/src");
      expect(watchPaths).toContain("packages/media-generation-core/src");
      expect(watchPaths).toContain("packages/acp-core/src");
      expect(watchPaths).toContain("packages/net-policy/src");
      expect(watchPaths).toContain("tsdown.config.ts");
      expect(watchOptions.ignoreInitial).toBe(true);
      expect(watchOptions.ignored("src")).toBe(false);
      expect(watchOptions.ignored("src/infra")).toBe(false);
      expect(watchOptions.ignored("packages/gateway-client/src/client.ts")).toBe(false);
      expect(watchOptions.ignored("packages/gateway-client/src/client.test.ts")).toBe(true);
      expect(watchOptions.ignored("packages/gateway-protocol/src/schema/cron.ts")).toBe(false);
      expect(watchOptions.ignored("packages/markdown-core/src/ir.ts")).toBe(false);
      expect(watchOptions.ignored("packages/markdown-core/src/ir.test.ts")).toBe(true);
      expect(watchOptions.ignored("packages/media-core/src/mime.ts")).toBe(false);
      expect(watchOptions.ignored("packages/media-core/src/mime.test.ts")).toBe(true);
      expect(watchOptions.ignored("packages/media-generation-core/src/model-ref.ts")).toBe(false);
      expect(watchOptions.ignored("packages/media-generation-core/src/model-ref.test.ts")).toBe(
        true,
      );
      expect(watchOptions.ignored("packages/acp-core/src/runtime/types.ts")).toBe(false);
      expect(watchOptions.ignored("packages/net-policy/src/ip.ts")).toBe(false);
      expect(watchOptions.ignored("packages/net-policy/src/ip.test.ts")).toBe(true);
      expect(watchOptions.ignored("extensions")).toBe(false);
      expect(watchOptions.ignored("extensions/voice-call")).toBe(false);
      expect(watchOptions.ignored("extensions/voice-call/dist")).toBe(true);
      expect(watchOptions.ignored("extensions/voice-call/node_modules")).toBe(true);
      expect(watchOptions.ignored("extensions/voice-call/node_modules/chokidar/index.js")).toBe(
        true,
      );
      expect(watchOptions.ignored("src/infra/watch-node.test.ts")).toBe(true);
      expect(watchOptions.ignored("src/infra/watch-node.test.tsx")).toBe(true);
      expect(watchOptions.ignored("src/infra/watch-node-test-helpers.ts")).toBe(true);
      expect(watchOptions.ignored(VOICE_CALL_README)).toBe(true);
      expect(watchOptions.ignored(VOICE_CALL_MANIFEST)).toBe(false);
      expect(watchOptions.ignored(VOICE_CALL_PACKAGE)).toBe(false);
      expect(watchOptions.ignored(VOICE_CALL_INDEX)).toBe(false);
      expect(watchOptions.ignored(VOICE_CALL_RUNTIME)).toBe(false);
      expect(watchOptions.ignored("src/infra/watch-node.ts")).toBe(false);
      expect(watchOptions.ignored("tsconfig.json")).toBe(false);

      expect(spawn).toHaveBeenCalledTimes(1);
      const spawnCall = requireMockCall(spawn, 0);
      expect(spawnCall[0]).toBe("/usr/local/bin/node");
      expect(spawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
      const spawnOptions = requireSpawnOptions(spawn, 0);
      expect(spawnOptions.cwd).toBe(cwd);
      expect(spawnOptions.stdio).toBe("inherit");
      const spawnEnv = requireSpawnEnv(spawn, 0);
      expect(spawnEnv.PATH).toBe("/usr/bin");
      expect(spawnEnv.OPENCLAW_WATCH_MODE).toBe("1");
      expect(spawnEnv.OPENCLAW_WATCH_SESSION).toBe("1700000000000-4242");
      expect(spawnEnv.OPENCLAW_NO_RESPAWN).toBe("1");
      expect(spawnEnv.OPENCLAW_WATCH_COMMAND).toBe("gateway --force");
      expect(spawnEnv.OPENCLAW_TRACE_SYNC_IO).toBeUndefined();
      fakeProcess.emit("SIGINT");
      const exitCode = await runPromise;
      expect(exitCode).toBe(130);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves explicit sync I/O trace overrides for gateway watch", async () => {
    const { child, spawn, createWatcher, fakeProcess } = createWatchHarness();
    await withTempDir({ prefix: "openclaw-watch-node-" }, async (cwd) => {
      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd,
        createWatcher,
        env: { OPENCLAW_TRACE_SYNC_IO: "0" },
        lockDisabled: true,
        process: fakeProcess,
        spawn,
      });

      const spawnCall = requireMockCall(spawn, 0);
      expect(spawnCall[0]).toBe("/usr/local/bin/node");
      expect(spawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
      expect(requireSpawnEnv(spawn, 0).OPENCLAW_TRACE_SYNC_IO).toBe("0");

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  it("starts the runner before loading chokidar", async () => {
    const child = createKillableChild();
    const spawn = vi.fn(() => child);
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
    });
    const watch = vi.fn(() => watcher);
    let resolveLoadChokidar: (value: { watch: typeof watch }) => void = () => {};
    const loadChokidar = vi.fn(
      () =>
        new Promise<{ watch: typeof watch }>((resolve) => {
          resolveLoadChokidar = resolve;
        }),
    );
    const fakeProcess = createFakeProcess();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      loadChokidar,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(loadChokidar).toHaveBeenCalledTimes(1);
    expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(
      loadChokidar.mock.invocationCallOrder[0],
    );

    resolveLoadChokidar({ watch });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(watch).toHaveBeenCalledTimes(1);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("terminates child on SIGINT and returns shell interrupt code", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;

    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("terminates child on SIGTERM and returns shell terminate code", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    fakeProcess.emit("SIGTERM");
    const exitCode = await runPromise;

    expect(exitCode).toBe(143);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("returns the child exit code when the runner exits on its own", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["config", "validate"],
      createWatcher,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    child.emit("exit", 0, null);
    const exitCode = await runPromise;

    expect(exitCode).toBe(0);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("runs doctor once and restarts when gateway exits nonzero", async () => {
    const gatewayA = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const doctor = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const gatewayB = createKillableChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(gatewayA)
      .mockReturnValueOnce(doctor)
      .mockReturnValueOnce(gatewayB);
    const { watcher, fakeProcess, runPromise } = startWatchRun({ env: {}, spawn });

    gatewayA.emit("exit", 1, null);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    const doctorSpawnCall = requireMockCall(spawn, 1);
    expect(doctorSpawnCall[0]).toBe("/usr/local/bin/node");
    expect(doctorSpawnCall[1]).toEqual([
      "scripts/run-node.mjs",
      "doctor",
      "--fix",
      "--non-interactive",
    ]);
    expect(requireSpawnOptions(spawn, 1).stdio).toBe("inherit");
    expect(requireSpawnEnv(spawn, 1).OPENCLAW_DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS).toBe("1");

    doctor.emit("exit", 0, null);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(spawn).toHaveBeenCalledTimes(3);
    const restartedGatewaySpawnCall = requireMockCall(spawn, 2);
    expect(restartedGatewaySpawnCall[0]).toBe("/usr/local/bin/node");
    expect(restartedGatewaySpawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
    expect(requireSpawnOptions(spawn, 2).stdio).toBe("inherit");
    expect(
      requireSpawnEnv(spawn, 2).OPENCLAW_DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS,
    ).toBeUndefined();

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(gatewayB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("does not run doctor after a gateway failure when auto doctor is disabled", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      env: { OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "0" },
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    child.emit("exit", 1, null);
    const exitCode = await runPromise;

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("restarts when the runner exits with a SIGTERM-derived code unexpectedly", async () => {
    const childA = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
    });
    const childB = createKillableChild();
    const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    const { watcher, fakeProcess, runPromise } = startWatchRun({ spawn });

    childA.emit("exit", 143, null);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(2);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("forces no-respawn for watch children even when supervisor hints are inherited", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      env: {
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
        PATH: "/usr/bin",
      },
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    const spawnCall = requireMockCall(spawn, 0);
    expect(spawnCall[0]).toBe("/usr/local/bin/node");
    expect(spawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
    const spawnEnv = requireSpawnEnv(spawn, 0);
    expect(spawnEnv.LAUNCH_JOB_LABEL).toBe("ai.openclaw.gateway");
    expect(spawnEnv.OPENCLAW_NO_RESPAWN).toBe("1");

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("ignores test-only changes and restarts on non-test source changes", async () => {
    const childA = createAutoExitChild();
    const childB = createAutoExitChild();
    const childC = createAutoExitChild();
    const childD = createKillableChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(childA)
      .mockReturnValueOnce(childB)
      .mockReturnValueOnce(childC)
      .mockReturnValueOnce(childD);
    const { watcher, fakeProcess, runPromise } = startWatchRun({ spawn });

    watcher.emit("change", "src/infra/watch-node.test.ts");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", "src/infra/watch-node.test.tsx");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", "src/infra/watch-node-test-helpers.ts");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", VOICE_CALL_README);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", VOICE_CALL_MANIFEST);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(2);

    watcher.emit("change", VOICE_CALL_PACKAGE);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(3);

    watcher.emit("change", "src/infra/watch-node.ts");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(childC.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(4);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
  });

  it("kills child and exits when watcher emits an error", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    watcher.emit("error", new Error("watch failed"));
    const exitCode = await runPromise;

    expect(exitCode).toBe(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("prints recovery guidance when chokidar fails with invalid package config", async () => {
    const error = Object.assign(
      new Error(
        'Invalid package config /tmp/openclaw/.pnpm/chokidar/package.json while importing "chokidar" from /tmp/openclaw/scripts/watch-node.mjs.',
      ),
      { code: "ERR_INVALID_PACKAGE_CONFIG" },
    );
    const child = createKillableChild();
    const spawn = vi.fn(() => child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runWatch({
          args: ["gateway", "--force"],
          cwd: "/tmp/openclaw",
          loadChokidar: vi.fn(async () => {
            throw error;
          }),
          process: createFakeProcess(),
          spawn,
        }),
      ).rejects.toBe(error);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(errorSpy.mock.calls).toEqual([
        [""],
        [
          "[openclaw] gateway:watch could not start because a dependency package config looks corrupted.",
        ],
        ["[openclaw] Invalid package config: /tmp/openclaw/.pnpm/chokidar/package.json"],
        ["[openclaw] This usually means a file in node_modules is empty or truncated."],
        ["[openclaw] Recommended recovery:"],
        ["[openclaw]   rm -rf node_modules"],
        ["[openclaw]   pnpm store prune"],
        ["[openclaw]   pnpm install"],
        [""],
        ["[openclaw] Original error:"],
        [error],
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not log non-package-config chokidar import errors before rethrowing", async () => {
    const error = Object.assign(new Error("Cannot find package 'chokidar'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const child = createKillableChild();
    const spawn = vi.fn(() => child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runWatch({
          loadChokidar: vi.fn(async () => {
            throw error;
          }),
          process: createFakeProcess(),
          spawn,
        }),
      ).rejects.toBe(error);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  describe("build readiness guard (#99603)", () => {
    function fakeProcessWithStderr() {
      const proc = createFakeProcess();
      const stderrWrite = vi.fn();
      Object.defineProperty(proc, "stderr", {
        value: { write: stderrWrite, isTTY: false },
        writable: true,
        configurable: true,
      });
      return { proc, stderrWrite };
    }

    const mockResolveBuild = vi.mocked(resolveBuildRequirement);
    const mockResolveRuntime = vi.mocked(resolveRuntimePostBuildRequirement);

    beforeEach(() => {
      mockResolveBuild.mockReturnValue({ shouldBuild: false, reason: "clean" });
      mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    // Hard failures: dist/ is physically broken, child CANNOT start → defer.
    const HARD_FAILURES = [
      "missing_dist_entry",
      "missing_bundled_plugin_dist_entry",
      "missing_private_qa_dist",
    ] as const;

    // Soft staleness: dist/ exists but is stale, run-node will rebuild → allow restart.
    // Soft staleness: dist/ exists but is stale, run-node will rebuild → allow restart.
    // Includes missing_build_stamp: usable dist/entry.js exists, stamp is metadata only.
    // Soft staleness: dist/ exists but is stale, run-node will rebuild → allow restart.
    const SOFT_STALENESS = [
      "missing_build_stamp",
      "git_head_changed",
      "dirty_watched_tree",
      "config_newer",
      "build_stamp_missing_head",
      "source_mtime_newer",
    ] as const;

    for (const reason of HARD_FAILURES) {
      it(`defers restart on hard failure: ${reason}`, async () => {
        const { child, spawn, watcher, createWatcher } = createWatchHarness();
        const { proc: fakeProcess, stderrWrite } = fakeProcessWithStderr();

        mockResolveBuild.mockReturnValue({ shouldBuild: true, reason });
        mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

        const runPromise = runWatch({
          args: ["gateway", "--force"],
          cwd: "/repo/openclaw",
          createWatcher,
          env: { PATH: "/usr/bin" },
          lockDisabled: true,
          process: fakeProcess,
          spawn,
        } as WatchRunParams);

        watcher.emit("change", "src/infra/something.ts");
        await new Promise((resolve) => {
          setImmediate(resolve);
        });

        expect(child.kill).not.toHaveBeenCalled();
        const stderrOutput = stderrWrite.mock.calls.map((c: unknown[]) => String(c[0])).join("");
        expect(stderrOutput).toContain("Build output not ready");

        fakeProcess.emit("SIGINT");
        await runPromise;
        expect(watcher.close).toHaveBeenCalledTimes(1);
      });
    }

    it("defers on runtime hard failure: missing_runtime_postbuild_output", async () => {
      const { child, spawn, watcher, createWatcher } = createWatchHarness();
      const { proc: fakeProcess, stderrWrite } = fakeProcessWithStderr();

      mockResolveBuild.mockReturnValue({ shouldBuild: false, reason: "clean" });
      mockResolveRuntime.mockReturnValue({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd: "/repo/openclaw",
        createWatcher,
        env: { PATH: "/usr/bin" },
        lockDisabled: true,
        process: fakeProcess,
        spawn,
      } as WatchRunParams);

      watcher.emit("change", "src/infra/something.ts");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(child.kill).not.toHaveBeenCalled();
      expect(stderrWrite.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain(
        "Build output not ready",
      );

      fakeProcess.emit("SIGINT");
      await runPromise;
    });

    for (const reason of SOFT_STALENESS) {
      it(`allows restart on soft staleness: ${reason} (run-node will rebuild)`, async () => {
        const childA = createKillableChild();
        const childB = createKillableChild();
        const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
        const watcher = Object.assign(new EventEmitter(), {
          close: vi.fn(async () => {}),
        });
        const createWatcher = vi.fn(() => watcher);
        const fakeProcess = createFakeProcess();

        mockResolveBuild.mockReturnValue({ shouldBuild: true, reason });
        mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

        // missing_build_stamp triggers a direct dist/entry.js existence check.
        // Provide a mock fs where entry.js exists so the guard proceeds normally.
        const extraParams: Record<string, unknown> = {};
        if (reason === "missing_build_stamp") {
          const distEntry = path.join("/repo/openclaw", "dist", "entry.js");
          extraParams.fs = {
            existsSync: vi.fn((filePath: string) => filePath === distEntry),
          } as unknown as typeof fs;
        }

        const runPromise = runWatch({
          args: ["gateway", "--force"],
          cwd: "/repo/openclaw",
          createWatcher,
          env: { PATH: "/usr/bin" },
          lockDisabled: true,
          process: fakeProcess,
          spawn,
          ...extraParams,
        } as WatchRunParams);

        watcher.emit("change", "src/infra/something.ts");
        await new Promise((resolve) => {
          setImmediate(resolve);
        });

        // Soft staleness → guard does NOT defer → child IS killed
        expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
        expect(spawn).toHaveBeenCalledTimes(2);

        fakeProcess.emit("SIGINT");
        await runPromise;
        expect(watcher.close).toHaveBeenCalledTimes(1);
      });
    }

    it("defers when both stamp and entry are missing (masked missing_dist_entry)", async () => {
      const { child, spawn, watcher, createWatcher } = createWatchHarness();
      const { proc: fakeProcess, stderrWrite } = fakeProcessWithStderr();

      // resolveBuildRequirement checks missing_build_stamp before missing_dist_entry.
      // When both are absent the reason is missing_build_stamp (soft), but dist/entry.js
      // is also gone — the direct entry check in isBuildReadyForRestart must catch this.
      mockResolveBuild.mockReturnValue({ shouldBuild: true, reason: "missing_build_stamp" });
      mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

      // Simulate entry.js missing via fs mock: the direct fs.existsSync check fails
      const distEntry = path.join("/repo/openclaw", "dist", "entry.js");
      const mockFs = {
        existsSync: vi.fn((filePath: string) => filePath !== distEntry),
      };

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd: "/repo/openclaw",
        createWatcher,
        env: { PATH: "/usr/bin" },
        fs: mockFs as unknown as typeof fs,
        lockDisabled: true,
        process: fakeProcess,
        spawn,
      } as WatchRunParams);

      watcher.emit("change", "src/infra/something.ts");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      // Both missing → hard failure → defer, child NOT killed
      expect(child.kill).not.toHaveBeenCalled();
      const stderrOutput = stderrWrite.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(stderrOutput).toContain("Build output not ready");

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });
    it("kills child normally when full readiness contract passes", async () => {
      const childA = createKillableChild();
      const childB = createKillableChild();
      const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
      const watcher = Object.assign(new EventEmitter(), {
        close: vi.fn(async () => {}),
      });
      const createWatcher = vi.fn(() => watcher);
      const fakeProcess = createFakeProcess();

      mockResolveBuild.mockReturnValue({ shouldBuild: false, reason: "clean" });
      mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd: "/repo/openclaw",
        createWatcher,
        env: { PATH: "/usr/bin" },
        lockDisabled: true,
        process: fakeProcess,
        spawn,
      } as WatchRunParams);

      watcher.emit("change", "src/infra/something.ts");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawn).toHaveBeenCalledTimes(2);

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });

    it("gives up after timeout when hard failure never recovers", async () => {
      const { child, spawn, watcher, createWatcher } = createWatchHarness();
      const { proc: fakeProcess, stderrWrite } = fakeProcessWithStderr();

      mockResolveBuild.mockReturnValue({ shouldBuild: true, reason: "missing_dist_entry" });
      mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

      let currentTime = 0;
      const mockNow = vi.fn(() => currentTime);
      const mockSleep = vi.fn(async (ms: number) => {
        currentTime += ms;
      });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd: "/repo/openclaw",
        createWatcher,
        env: { PATH: "/usr/bin" },
        lockDisabled: true,
        now: mockNow,
        process: fakeProcess,
        sleep: mockSleep,
        spawn,
      } as WatchRunParams);

      watcher.emit("change", "src/infra/something.ts");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(child.kill).not.toHaveBeenCalled();

      await mockSleep(5 * 60 * 1000 + 100);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(child.kill).not.toHaveBeenCalled();
      const stderrOutput = stderrWrite.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(stderrOutput).toContain("giving up");

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });

    it("clears stale restartRequested after timeout so later child exit proceeds normally", async () => {
      const { child, spawn, watcher, createWatcher } = createWatchHarness();
      const { proc: fakeProcess } = fakeProcessWithStderr();

      mockResolveBuild.mockReturnValue({ shouldBuild: true, reason: "missing_dist_entry" });
      mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

      let currentTime = 0;
      const mockNow = vi.fn(() => currentTime);
      const mockSleep = vi.fn(async (ms: number) => {
        currentTime += ms;
      });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd: "/repo/openclaw",
        createWatcher,
        env: { PATH: "/usr/bin", OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "0" },
        lockDisabled: true,
        now: mockNow,
        process: fakeProcess,
        sleep: mockSleep,
        spawn,
      } as WatchRunParams);

      // Trigger restart → hard failure → defer → poll starts, restartRequested=true
      watcher.emit("change", "src/infra/something.ts");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(child.kill).not.toHaveBeenCalled();

      // Timeout → restartRequested cleared by timeout path
      await mockSleep(5 * 60 * 1000 + 100);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      // Now mock readiness as clean so normal child exit proceeds
      mockResolveBuild.mockReturnValue({ shouldBuild: false, reason: "clean" });

      // Child exits with non-SIGTERM code (e.g. 1). If restartRequested were
      // still stale, exit handler would enter the restart branch and call
      // startRunner. With restartRequested cleared and auto-doctor disabled,
      // exit handler proceeds to settle (the non-zero code is not restartable).
      child.emit("exit", 1, null);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      // Should NOT have restarted — staleness cleared, exit code 1 is not restartable
      expect(spawn).toHaveBeenCalledTimes(1);

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });

    it("defers child-exit restart on hard failure", async () => {
      const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

      mockResolveBuild.mockReturnValue({ shouldBuild: true, reason: "missing_dist_entry" });
      mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        createWatcher,
        env: { PATH: "/usr/bin" },
        lockDisabled: true,
        process: fakeProcess,
        spawn,
      } as WatchRunParams);

      child.emit("exit", 143, null);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      // Hard failure → guard deferred
      expect(spawn).toHaveBeenCalledTimes(1);

      // Now recovery: readiness passes
      mockResolveBuild.mockReturnValue({ shouldBuild: false, reason: "clean" });
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      expect(spawn).toHaveBeenCalledTimes(2);

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });

    it("coalesces multiple file changes into single deferral loop", async () => {
      const { child, spawn, watcher, createWatcher } = createWatchHarness();
      const { proc: fakeProcess } = fakeProcessWithStderr();

      mockResolveBuild.mockReturnValue({ shouldBuild: true, reason: "missing_dist_entry" });
      mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd: "/repo/openclaw",
        createWatcher,
        env: { PATH: "/usr/bin" },
        lockDisabled: true,
        process: fakeProcess,
        spawn,
      } as WatchRunParams);

      // First change → deferral starts
      watcher.emit("change", "src/infra/a.ts");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(child.kill).not.toHaveBeenCalled();

      // Second change during deferral → single-flight guard, no new loop
      watcher.emit("change", "src/infra/b.ts");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(child.kill).not.toHaveBeenCalled();

      // Build becomes ready → child killed exactly once
      mockResolveBuild.mockReturnValue({ shouldBuild: false, reason: "clean" });
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });

    it("recovers requestRestart when entry reappears then sends SIGTERM", async () => {
      const childA = createKillableChild();
      const childB = createKillableChild();
      const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
      const watcher = Object.assign(new EventEmitter(), {
        close: vi.fn(async () => {}),
      });
      const createWatcher = vi.fn(() => watcher);
      const fakeProcess = createFakeProcess();

      mockResolveBuild.mockReturnValue({ shouldBuild: true, reason: "missing_dist_entry" });
      mockResolveRuntime.mockReturnValue({ shouldSync: false, reason: "clean" });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd: "/repo/openclaw",
        createWatcher,
        env: { PATH: "/usr/bin" },
        lockDisabled: true,
        process: fakeProcess,
        spawn,
      } as WatchRunParams);

      watcher.emit("change", "src/infra/something.ts");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      // Deferred: child NOT killed yet
      expect(childA.kill).not.toHaveBeenCalled();

      // Build becomes ready → guard passes → kill child → exit handler restarts
      mockResolveBuild.mockReturnValue({ shouldBuild: false, reason: "clean" });
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
      expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawn).toHaveBeenCalledTimes(2);

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });
  });

  it("replaces an existing watcher lock holder before starting", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();
    await withTempDir({ prefix: "openclaw-watch-node-lock-" }, async (cwd) => {
      const lockPath = resolveTestWatchLockPath(cwd, ["gateway", "--force"]);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({
          pid: 2121,
          command: "gateway --force",
          createdAt: new Date(1_700_000_000_000).toISOString(),
          cwd,
          watchSession: "existing-session",
        })}\n`,
        "utf8",
      );

      let existingWatcherAlive = true;
      const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) {
          if (pid === 2121 && existingWatcherAlive) {
            return;
          }
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        if (pid === 2121 && signal === "SIGTERM") {
          existingWatcherAlive = false;
          return;
        }
        throw new Error(`unexpected signal ${signal} for pid ${pid}`);
      });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        createWatcher,
        cwd,
        now: () => 1_700_000_000_000,
        process: fakeProcess,
        signalProcess,
        sleep: async () => {},
        spawn,
      });

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(signalProcess).toHaveBeenCalledWith(2121, "SIGTERM");
      expect(spawn).toHaveBeenCalledTimes(1);
      const lockRecord = requireRecord(JSON.parse(fs.readFileSync(lockPath, "utf8")), "watch lock");
      expect(lockRecord.pid).toBe(4242);
      expect(lockRecord.command).toBe("gateway --force");
      expect(lockRecord.watchSession).toBe("1700000000000-4242");

      fakeProcess.emit("SIGINT");
      const exitCode = await runPromise;

      expect(exitCode).toBe(130);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });
  });
});
