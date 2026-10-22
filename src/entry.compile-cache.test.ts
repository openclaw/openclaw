// Tests compile-cache child-process spawning and environment propagation.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:module";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock, MockInstance } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../cli-parent-lifetime.mjs";
import { awaitGateBeforeSettlement } from "../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import {
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./daemon/windows-task-supervisor-contract.js";
import { createDeferredCore } from "./shared/deferred.js";
import { withMockedPlatform } from "./test-utils/vitest-spies.js";

type Spawn = (...args: Parameters<typeof import("node:child_process").spawn>) => ChildProcess;

const { enableCompileCache, getCompileCacheDir, spawn, attachChildProcessBridge } = vi.hoisted(
  () => ({
    enableCompileCache: vi.fn<typeof import("node:module").enableCompileCache>(),
    getCompileCacheDir: vi.fn<() => string | undefined>(),
    spawn: vi.fn<Spawn>(),
    attachChildProcessBridge:
      vi.fn<typeof import("./process/child-process-bridge.js").attachChildProcessBridge>(),
  }),
);

// Node's enabled cache survives subsequent calls in the same instance. Observe the
// API boundary without enabling a real cache in the shared Vitest worker.
vi.mock("node:module", async (importOriginal) => {
  const { mockNodeBuiltinModule } = await import("./plugin-sdk/test-helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(() => importOriginal<typeof import("node:module")>(), {
    enableCompileCache,
    getCompileCacheDir,
  });
});
vi.mock("node:child_process", async (importOriginal) => {
  const { mockNodeBuiltinModule } = await import("./plugin-sdk/test-helpers/node-builtin-mocks.js");
  // The fixture covers the three-argument spawn call used with inherited stdio.
  return mockNodeBuiltinModule<{ spawn: Spawn }>(
    () => importOriginal<typeof import("node:child_process")>(),
    { spawn },
    { mirrorToDefault: true },
  );
});
vi.mock("./process/child-process-bridge.js", () => ({ attachChildProcessBridge }));

import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded as respawnCompileCache,
} from "./entry.compile-cache.js";
import { resolveNodeCompileCacheEnv } from "./infra/node-compile-cache-env.js";

describe("entry compile cache", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  let entryFile: string;
  let argv: string[];
  let child: ChildProcess;
  let kill: Mock<ChildProcess["kill"]>;
  let processKill: MockInstance<typeof process.kill>;
  let originalExitCode: typeof process.exitCode;
  let spawned: ReturnType<typeof createDeferredCore<void>>;
  const pending: Array<Promise<boolean>> = [];
  let writeStderr: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    root = tempDirs.make("openclaw-compile-cache-");
    entryFile = path.join(root, "dist", "entry.js");
    argv = [process.execPath, entryFile, "status", "--json"];
    vi.stubEnv("NODE_COMPILE_CACHE", path.join(root, ".node-cache"));
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", undefined);
    vi.stubEnv("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED", undefined);
    enableCompileCache.mockReset().mockReturnValue({
      status: constants.compileCacheStatus.ALREADY_ENABLED,
      directory: path.join(root, ".node-cache"),
    });
    getCompileCacheDir.mockReset();
    attachChildProcessBridge.mockReset().mockReturnValue({ detach: vi.fn() });
    child = new EventEmitter() as ChildProcess;
    kill = vi.fn(() => true);
    child.kill = kill;
    spawned = createDeferredCore();
    spawn.mockReset().mockImplementation(() => {
      spawned.resolve();
      return child;
    });
    vi.spyOn(process, "argv", "get").mockImplementation(() => argv);
    vi.spyOn(process, "execArgv", "get").mockReturnValue(["--no-warnings"]);
    processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    originalExitCode = process.exitCode;
    // A nondefault status proves settlement has not published either success or failure.
    process.exitCode = 17;
    writeStderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    child.emit("close", 0, null);
    await Promise.allSettled(pending.splice(0));
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function respawn(options: Omit<Parameters<typeof respawnCompileCache>[0], "currentFile"> = {}) {
    const completion = respawnCompileCache({ currentFile: entryFile, ...options });
    pending.push(completion);
    return completion;
  }

  async function startRespawn() {
    const completion = respawn();
    await awaitGateBeforeSettlement(
      spawned.promise,
      completion,
      "compile-cache respawn did not start",
    );
    return { completion };
  }

  function useSourceEntry() {
    // The respawn policy classifies the entry extension; it never reads this file.
    entryFile = path.join(root, "src", "entry.ts");
    argv[1] = entryFile;
  }

  function enableCache(env: NodeJS.ProcessEnv = {}) {
    enableOpenClawCompileCache({ currentFile: entryFile, env, installRoot: root });
  }

  it("resolves install roots from source and dist entry paths", () => {
    expect(resolveEntryInstallRoot("/repo/openclaw/src/entry.ts")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/repo/openclaw/dist/entry.js")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/pkg/openclaw/entry.js")).toBe("/pkg/openclaw");
  });

  it("activates compiled worker cache unless explicitly disabled", () => {
    argv = [process.execPath, entryFile, "gateway", "run"];
    enableCache();
    expect(enableCompileCache).toHaveBeenCalledTimes(1);
    enableCache({ NODE_DISABLE_COMPILE_CACHE: "1" });
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", "1");
    enableOpenClawCompileCache({ currentFile: entryFile, installRoot: root });
    expect(enableCompileCache).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["gateway", WINDOWS_TASK_SUPERVISOR_FLAG],
    ["gateway", "run", `${WINDOWS_TASK_SUPERVISOR_CHILD_FLAG}=65536`],
  ])("keeps worker caching for Windows service arguments: %j", (...args) => {
    argv = [process.execPath, entryFile, ...args];
    enableCache();
    expect(enableCompileCache).toHaveBeenCalledTimes(1);
  });

  it("keeps compiled one-shot commands free of automatic exit-time cache work", () => {
    argv = [process.execPath, entryFile, "config", "set", "gateway.mode", "local"];
    enableCache();
    expect(enableCompileCache).not.toHaveBeenCalled();
    enableCache({ NODE_COMPILE_CACHE: path.join(root, ".requested-cache") });
    expect(enableCompileCache).toHaveBeenCalledOnce();
  });

  it("skips cache activation with a warning when Windows TEMP makes the path too long", () => {
    argv = [process.execPath, entryFile, "gateway", "run"];
    vi.spyOn(os, "tmpdir").mockReturnValue(path.join(root, "x".repeat(200)));
    withMockedPlatform("win32", () => {
      enableCache();
    });
    expect(enableCompileCache).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Compile cache disabled: Windows cache path exceeds 200 characters"),
    );
  });

  it.each([200, 201])("bounds Windows child cache paths at 200 characters: %s", (length) => {
    const directory = path.join(root, "x".repeat(length - root.length - 1));
    const env = { NODE_COMPILE_CACHE: directory, KEEP: "unchanged" };
    withMockedPlatform("win32", () => {
      const childEnv = resolveNodeCompileCacheEnv(env);
      if (length === 200) {
        expect(childEnv).toBe(env);
        expect(writeStderr).not.toHaveBeenCalled();
      } else {
        expect(childEnv).toEqual({ NODE_DISABLE_COMPILE_CACHE: "1", KEEP: "unchanged" });
        expect(writeStderr).toHaveBeenCalledOnce();
      }
    });
    expect(env.NODE_COMPILE_CACHE).toBe(directory);
  });

  it.each([
    { mode: "inherited", cli: ["status", "--json"] },
    { mode: "active", cli: ["status", "--json"] },
    { mode: "standalone", cli: ["status", "--json"] },
    { mode: "interactive", cli: [] },
    { mode: "interactive", cli: ["tui"] },
  ])("respawns $mode without caching: $cli", async ({ mode, cli }) => {
    useSourceEntry();
    argv = [process.execPath, entryFile, ...cli];
    if (mode === "active") {
      vi.stubEnv("NODE_COMPILE_CACHE", undefined);
      getCompileCacheDir.mockReturnValue(path.join(root, ".active-cache"));
    }
    const standalone = mode === "standalone";
    if (standalone) {
      vi.stubGlobal("__openclawStandaloneRootUrl", new URL(`file://${root}/`).href);
    }
    const { completion } = await startRespawn();
    expect(spawn).toHaveBeenCalledOnce();
    const [command, args, options] = expectDefined(spawn.mock.calls[0], "respawn call");
    expect({ command, args, options }).toMatchObject({
      command: process.execPath,
      args: standalone
        ? cli
        : ["--import", CLI_PARENT_BOUND_PRELOAD, "--no-warnings", entryFile, ...cli],
      options: {
        env: { NODE_DISABLE_COMPILE_CACHE: "1", OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED: "1" },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        detached:
          mode !== "interactive" &&
          process.platform !== "win32" &&
          !(process.stdin.isTTY || process.stdout.isTTY),
      },
    });
    expect(options?.env?.NODE_COMPILE_CACHE).toBeUndefined();
    if (standalone) {
      expect(options?.env?.OPENCLAW_CLI_RESPAWN_PARENT).toBe(String(process.pid));
    }
    expect(attachChildProcessBridge).toHaveBeenCalledWith(child, expect.any(Function));
    child.emit("exit", 0, null);
    expect(process.exitCode).toBe(17);
    child.emit("close", 0, null);
    await expect(completion).resolves.toBe(true);
    expect(process.exitCode).toBe(0);
    expect(writeStderr).not.toHaveBeenCalled();
  });

  const commands = {
    hooks: ["hooks", "relay", "--relay-id", "relay-1"],
    gmail: ["webhooks", "--profile", "fixture", "gmail", "run"],
    gateway: ["--profile=fixture", "gateway", "run"],
    status: ["status", "--json"],
  };
  it.each([
    ["hooks", "linux", "source", false],
    ["hooks", "win32", "source", true],
    ["gmail", "linux", "source", false],
    ["gmail", "win32", "source", false],
    ["gateway", "linux", "source", false],
    ["status", "linux", "package", false],
    ["status", "linux", "respawned", false],
  ] as const)(
    "respects %s/%s respawn policy for %s",
    async (command, platform, install, respawns) => {
      if (install !== "package") {
        useSourceEntry();
      }
      if (install === "respawned") {
        vi.stubEnv("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED", "1");
      }
      argv = [process.execPath, entryFile, ...commands[command]];
      await withMockedPlatform(platform, async () => {
        const completion = respawn();
        if (respawns) {
          await spawned.promise;
          child.emit("close", 0, null);
        }
        await expect(completion).resolves.toBe(respawns);
        expect(spawn).toHaveBeenCalledTimes(respawns ? 1 : 0);
      });
    },
  );

  it.each(["linux", "win32"] as const)(
    "waits for a signaled compile-cache respawn child after force-killing it on %s",
    async (platform) => {
      useSourceEntry();
      argv = [process.execPath, entryFile, "tui"];
      vi.useFakeTimers();
      await withMockedPlatform(platform, async () => {
        const { completion } = await startRespawn();
        const [, onSignal] = expectDefined(attachChildProcessBridge.mock.calls[0], "bridge call");
        expectDefined(onSignal, "signal handler")("SIGTERM");
        vi.advanceTimersByTime(1_000);
        expect(kill).toHaveBeenCalledWith("SIGTERM");
        expect(process.exitCode).toBe(17);
        vi.advanceTimersByTime(1_000);
        expect(kill).toHaveBeenCalledWith(platform === "win32" ? "SIGTERM" : "SIGKILL");
        expect(process.exitCode).toBe(17);
        expect(processKill).not.toHaveBeenCalled();
        child.emit("exit", null, "SIGKILL");
        expect(process.exitCode).toBe(17);
        expect(processKill).not.toHaveBeenCalled();
        child.emit("close", null, "SIGKILL");
        await expect(completion).resolves.toBe(true);
        expect(process.exitCode).toBe(platform === "win32" ? 1 : 137);
        if (platform === "win32") {
          expect(processKill).not.toHaveBeenCalled();
        } else {
          expect(processKill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGKILL");
        }
      });
    },
  );

  it("awaits diagnostic setup while preserving the child environment snapshot", async () => {
    useSourceEntry();
    vi.stubEnv("OPENCLAW_PROFILE", "before-diagnostics");
    const writer = createDeferredCore<(message: string) => void>();
    const writeError = vi.fn();
    const prepareWriteError = vi.fn(() => writer.promise);
    const diagnosticCompletion = respawn({ prepareWriteError });
    try {
      expect(prepareWriteError).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      vi.stubEnv("OPENCLAW_PROFILE", "after-diagnostics");
    } finally {
      writer.resolve(writeError);
      await spawned.promise;
    }
    expect(expectDefined(spawn.mock.calls[0], "respawn call")[2]?.env?.OPENCLAW_PROFILE).toBe(
      "before-diagnostics",
    );
    child.emit("error", new Error("spawn failed"));
    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Failed to respawn CLI without compile cache: Error: spawn failed"),
    );
    expect(writeStderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(17);
    child.emit("close", -2, null);
    await expect(diagnosticCompletion).resolves.toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
