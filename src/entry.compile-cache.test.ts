// Tests compile-cache child-process spawning and environment propagation.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined, readStringValue } from "@openclaw/normalization-core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import { maintainOpenClawCompileCache } from "../node-compile-cache.mjs";
import { awaitGateBeforeSettlement } from "../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { createDeferredCore } from "./shared/deferred.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "./test-utils/env.js";
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
  );
});
vi.mock("./process/child-process-bridge.js", () => ({ attachChildProcessBridge }));

import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded as respawnCompileCache,
} from "./entry.compile-cache.js";
import { resolveNodeCompileCacheEnv } from "./infra/node-compile-cache-env.js";

function enabledDirectory(callIndex = 0): string {
  const [directory] = expectDefined(enableCompileCache.mock.calls[callIndex], "cache enable call");
  return expectDefined(readStringValue(directory), "cache directory string");
}

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
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(async () => {
    const { constants } = await import("node:module");
    root = tempDirs.make("openclaw-compile-cache-");
    entryFile = path.join(root, "dist", "entry.js");
    argv = [process.execPath, entryFile, "status", "--json"];
    envSnapshot = captureEnv([
      "NODE_COMPILE_CACHE",
      "NODE_DISABLE_COMPILE_CACHE",
      "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED",
      "OPENCLAW_PROFILE",
    ]);
    setTestEnvValue("NODE_COMPILE_CACHE", path.join(root, ".node-cache"));
    deleteTestEnvValue("NODE_DISABLE_COMPILE_CACHE");
    deleteTestEnvValue("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED");
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
    child.emit("close", 0, null);
    await Promise.allSettled(pending.splice(0));
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    envSnapshot.restore();
  });

  function respawnWithoutOpenClawCompileCacheIfNeeded(
    params: Parameters<typeof respawnCompileCache>[0],
  ) {
    const completion = respawnCompileCache(params);
    pending.push(completion);
    return completion;
  }

  async function startRespawn(params: Parameters<typeof respawnCompileCache>[0]) {
    const completion = respawnWithoutOpenClawCompileCacheIfNeeded(params);
    await awaitGateBeforeSettlement(
      spawned.promise,
      completion,
      "compile-cache respawn did not start",
    );
    return { completion };
  }

  async function markSourceCheckout() {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "entry.ts"), "export {};\n", "utf8");
  }

  it("resolves install roots from source and dist entry paths", () => {
    expect(resolveEntryInstallRoot("/repo/openclaw/src/entry.ts")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/repo/openclaw/dist/entry.js")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/pkg/openclaw/entry.js")).toBe("/pkg/openclaw");
  });

  it.each(["git", "source", "package"])(
    "activates compile cache only for an enabled %s install",
    async (kind) => {
      if (kind === "git") {
        await fs.writeFile(path.join(root, ".git"), "gitdir: .git/worktrees/openclaw\n", "utf8");
      } else if (kind === "source") {
        await markSourceCheckout();
      }
      enableOpenClawCompileCache({ env: {}, installRoot: root });
      expect(enableCompileCache).toHaveBeenCalledTimes(kind === "package" ? 1 : 0);
      enableOpenClawCompileCache({ env: { NODE_DISABLE_COMPILE_CACHE: "1" }, installRoot: root });
      setTestEnvValue("NODE_DISABLE_COMPILE_CACHE", "1");
      enableOpenClawCompileCache({ installRoot: root });
      expect(enableCompileCache).toHaveBeenCalledTimes(kind === "package" ? 1 : 0);
    },
  );

  it("skips cache activation with a warning when Windows TEMP makes the path too long", () => {
    vi.spyOn(os, "tmpdir").mockReturnValue(path.join(root, "x".repeat(200)));
    withMockedPlatform("win32", () => {
      enableOpenClawCompileCache({ env: {}, installRoot: root });
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

  it("isolates replaced installation metadata while retaining recent compile caches", async () => {
    const packageJsonPath = path.join(root, "package.json");
    const env = { NODE_COMPILE_CACHE: path.join(root, ".node-cache") };
    await fs.writeFile(packageJsonPath, '{"version":"2026.4.29"}\n', "utf8");
    enableOpenClawCompileCache({ env, installRoot: root });
    const originalDirectory = enabledDirectory();
    expect(originalDirectory).toContain(path.join(".node-cache", "openclaw"));
    expect(originalDirectory).toContain("2026.4.29");
    expect(path.basename(originalDirectory)).toMatch(/^\d+-\d+$/);
    await fs.mkdir(originalDirectory, { recursive: true });
    const originalCacheEntry = path.join(originalDirectory, "keep.txt");
    await fs.writeFile(originalCacheEntry, "previous cached installation\n", "utf8");
    const sharedCacheEntry = path.join(env.NODE_COMPILE_CACHE, "another-application");
    await fs.writeFile(sharedCacheEntry, "keep\n");
    await fs.writeFile(
      packageJsonPath,
      '{"version":"2026.4.29","installation":"replacement"}\n',
      "utf8",
    );
    enableOpenClawCompileCache({ env, installRoot: root });
    const replacementDirectory = enabledDirectory(1);
    expect(replacementDirectory).toContain(path.join("openclaw", "2026.4.29"));
    expect(replacementDirectory).not.toBe(originalDirectory);
    await maintainOpenClawCompileCache(replacementDirectory);
    await expect(fs.readFile(originalCacheEntry, "utf8")).resolves.toBe(
      "previous cached installation\n",
    );
    await expect(fs.readFile(sharedCacheEntry, "utf8")).resolves.toBe("keep\n");
  });

  it.each(["inherited", "active"])(
    "runs a one-shot no-cache respawn for an %s cache",
    async (cache) => {
      await markSourceCheckout();
      if (cache === "active") {
        deleteTestEnvValue("NODE_COMPILE_CACHE");
        getCompileCacheDir.mockReturnValue(path.join(root, ".active-cache"));
      }
      const { completion } = await startRespawn({ currentFile: entryFile, installRoot: root });
      expect(spawn).toHaveBeenCalledOnce();
      const [command, args, options] = expectDefined(spawn.mock.calls[0], "respawn call");
      expect(command).toBe(process.execPath);
      expect(args).toEqual(["--no-warnings", entryFile, "status", "--json"]);
      expect(options?.env?.NODE_DISABLE_COMPILE_CACHE).toBe("1");
      expect(options?.env?.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED).toBe("1");
      expect(options?.env?.NODE_COMPILE_CACHE).toBeUndefined();
      expect(options?.stdio).toBe("inherit");
      expect(options?.detached).toBe(
        process.platform !== "win32" && !(process.stdin.isTTY || process.stdout.isTTY),
      );
      expect(attachChildProcessBridge).toHaveBeenCalledWith(child, {
        onSignal: expect.any(Function),
      });
      child.emit("exit", 0, null);
      expect(process.exitCode).toBe(17);
      child.emit("close", 0, null);
      await expect(completion).resolves.toBe(true);
      expect(process.exitCode).toBe(0);
      expect(writeStderr).not.toHaveBeenCalled();
    },
  );

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
        await markSourceCheckout();
      }
      if (install === "respawned") {
        setTestEnvValue("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED", "1");
      }
      if (command === "hooks" || command === "gmail") {
        entryFile = path.join(root, "src", "entry.ts");
      }
      argv = [process.execPath, entryFile, ...commands[command]];
      await withMockedPlatform(platform, async () => {
        const completion = respawnWithoutOpenClawCompileCacheIfNeeded({
          currentFile: entryFile,
          installRoot: root,
        });
        if (respawns) {
          await spawned.promise;
          child.emit("close", 0, null);
        }
        await expect(completion).resolves.toBe(respawns);
        expect(spawn).toHaveBeenCalledTimes(respawns ? 1 : 0);
      });
    },
  );

  it.each([[], ["tui"]])("keeps interactive no-cache respawns attached: %j", async (...command) => {
    await markSourceCheckout();
    argv = [process.execPath, entryFile, ...command];
    const { completion } = await startRespawn({ currentFile: entryFile, installRoot: root });
    expect(expectDefined(spawn.mock.calls[0], "respawn call")[2]?.detached).toBe(false);
    child.emit("close", 0, null);
    await completion;
  });

  it.each(["linux", "win32"] as const)(
    "waits for a signaled compile-cache respawn child after force-killing it on %s",
    async (platform) => {
      await markSourceCheckout();
      argv = [process.execPath, entryFile, "tui"];
      vi.useFakeTimers();
      try {
        await withMockedPlatform(platform, async () => {
          const { completion } = await startRespawn({
            currentFile: entryFile,
            installRoot: root,
          });
          const [, options] = expectDefined(attachChildProcessBridge.mock.calls[0], "bridge call");
          expectDefined(options?.onSignal, "signal handler")("SIGTERM");
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
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("awaits diagnostic setup while preserving the child environment snapshot", async () => {
    await markSourceCheckout();
    setTestEnvValue("OPENCLAW_PROFILE", "before-diagnostics");
    const writer = createDeferredCore<(message: string) => void>();
    const writeError = vi.fn();
    const prepareWriteError = vi.fn(() => writer.promise);
    const diagnosticCompletion = respawnWithoutOpenClawCompileCacheIfNeeded({
      currentFile: entryFile,
      installRoot: root,
      prepareWriteError,
    });
    try {
      expect(prepareWriteError).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      setTestEnvValue("OPENCLAW_PROFILE", "after-diagnostics");
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
