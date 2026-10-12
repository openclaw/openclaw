// Tests executable behavior for the legacy package entrypoint.
import { existsSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliWithExitFinalization } from "./cli/one-shot-exit.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isMainModule } from "./infra/is-main.js";
import { completePendingPackageLifecycle } from "./infra/package-lifecycle.js";
import { withMockedPlatform } from "./test-utils/vitest-spies.js";

const compileCache = vi.hoisted(() => ({
  enable: vi.fn<typeof import("node:module").enableCompileCache>(),
  directory: vi.fn<() => string | undefined>(),
  respawn: vi.fn<typeof import("../node-runtime-recovery.mjs").runRespawnedChild>(async () => true),
}));
vi.mock("../node-runtime-recovery.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../node-runtime-recovery.mjs")>()),
  runRespawnedChild: compileCache.respawn,
}));
vi.mock("node:module", async (importOriginal) => {
  const { mockNodeBuiltinModule } = await import("./plugin-sdk/test-helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(() => importOriginal<typeof import("node:module")>(), {
    enableCompileCache: compileCache.enable,
    getCompileCacheDir: compileCache.directory,
  });
});

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));

vi.mock("./cli/run-main.js", () => ({
  runCli: vi.fn(async () => undefined),
}));
const lifecycleImports = vi.hoisted(() => ({ failureOutput: vi.fn() }));

vi.mock("./cli/one-shot-exit.js", () => ({
  runCliWithExitFinalization: vi.fn(),
}));
vi.mock("./cli/failure-output.js", () => {
  lifecycleImports.failureOutput();
  return {
    formatCliFailureLines: vi.fn(() => []),
    formatCliJsonFailure: vi.fn(),
    isExpectedCliError: vi.fn(() => false),
  };
});
vi.mock("./entry.version-fast-path.js", () => ({
  tryHandleRootVersionFastPath: vi.fn(() => false),
}));
vi.mock("./infra/is-main.js", () => ({
  isMainModule: vi.fn(() => true),
}));
vi.mock("./infra/package-lifecycle.js", () => ({
  completePendingPackageLifecycle: vi.fn(async () => true),
}));
vi.mock("./library.js", () => ({
  applyTemplate: vi.fn(),
  createDefaultDeps: vi.fn(),
  deriveSessionKey: vi.fn(),
  describePortOwner: vi.fn(),
  ensureBinary: vi.fn(),
  ensurePortAvailable: vi.fn(),
  getReplyFromConfig: vi.fn(),
  handlePortError: vi.fn(),
  loadConfig: vi.fn(),
  monitorWebChannel: vi.fn(),
  normalizeE164: vi.fn(),
  PortInUseError: class PortInUseError extends Error {},
  promptYesNo: vi.fn(),
  resolveSessionKey: vi.fn(),
  resolveStorePath: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  runExec: vi.fn(),
  waitForever: vi.fn(),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

describe("legacy package executable entrypoint", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(isMainModule).mockReturnValue(true);
    vi.mocked(tryHandleRootVersionFastPath).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(completePendingPackageLifecycle).mockResolvedValue(true);
    lifecycleImports.failureOutput.mockClear();
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", undefined);
    vi.stubEnv("NODE_COMPILE_CACHE", undefined);
    vi.stubEnv("OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED", undefined);
    compileCache.directory.mockReturnValue(undefined);
    const { constants } = await import("node:module");
    compileCache.enable.mockReturnValue({ status: constants.compileCacheStatus.ALREADY_ENABLED });
    process.argv = ["node", "dist/index.js", "status"];
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { mode: "version", args: ["--version"], main: true, handled: true, loadsFailure: false },
    { mode: "CLI", args: ["status"], main: true, handled: false, loadsFailure: true },
    { mode: "library", args: ["status"], main: false, handled: false, loadsFailure: false },
  ])(
    "loads only the modules needed for $mode",
    async ({ mode, args, main, handled, loadsFailure }) => {
      process.argv = ["node", "dist/index.js", ...args];
      vi.mocked(isMainModule).mockReturnValue(main);
      vi.mocked(tryHandleRootVersionFastPath).mockReturnValue(handled);
      const entry = await import("./index.js?legacy-entry-mode" as "./index.js");
      expect(lifecycleImports.failureOutput).toHaveBeenCalledTimes(loadsFailure ? 1 : 0);
      expect(compileCache.enable).toHaveBeenCalledTimes(loadsFailure ? 1 : 0);
      if (loadsFailure) {
        expect(compileCache.enable).toHaveBeenCalledBefore(lifecycleImports.failureOutput);
      }
      if (mode === "library") {
        expect(typeof entry.loadConfig).toBe("function");
      }
      if (handled) {
        const runMain = await import("./cli/run-main.js");
        const exitFinalization = await import("./cli/one-shot-exit.js");
        expect(tryHandleRootVersionFastPath).toHaveBeenCalledWith(process.argv);
        expect(runMain.runCli).not.toHaveBeenCalled();
        expect(exitFinalization.runCliWithExitFinalization).not.toHaveBeenCalled();
      }
    },
  );

  it("continues startup with one diagnostic when the compile cache is unavailable", async () => {
    const { constants } = await import("node:module");
    compileCache.enable.mockReturnValue({ status: constants.compileCacheStatus.FAILED });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("./index.js?unwritable-compile-cache" as "./index.js");
    vi.resetModules();
    await import("./index.js?unwritable-compile-cache-again" as "./index.js");
    expect(runCliWithExitFinalization).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "[openclaw] Compile cache unavailable; continuing without it.\n",
    );
  });

  it("honors explicit compile-cache disabling", async () => {
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", "1");
    await import("./index.js?disabled-compile-cache" as "./index.js");
    expect(compileCache.enable).not.toHaveBeenCalled();
    expect(runCliWithExitFinalization).toHaveBeenCalledOnce();
  });

  it("scopes an inherited cache before starting the direct CLI", async () => {
    const base = path.resolve("inherited-node-cache");
    vi.stubEnv("NODE_COMPILE_CACHE", base);
    compileCache.directory.mockReturnValue(path.join(base, "node-version-leaf"));
    await import("./index.js?inherited-compile-cache" as "./index.js");
    expect(compileCache.respawn).toHaveBeenCalledOnce();
    const [command, args, env] = expectDefined(
      compileCache.respawn.mock.calls[0],
      "cache respawn call",
    );
    expect(command).toBe(process.execPath);
    expect(args).toEqual([...process.execArgv, expect.stringMatching(/[\\/]index\.ts$/), "status"]);
    expect(env.NODE_COMPILE_CACHE).toContain(path.join(base, "openclaw"));
    expect(env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED).toBe("1");
    expect(compileCache.enable).not.toHaveBeenCalled();
    expect(runCliWithExitFinalization).not.toHaveBeenCalled();
  });

  it.each([
    ["webhooks", "gmail", "run"],
    ["hooks", "relay"],
  ])("keeps foreground %s in-process with an inherited cache", async (...command) => {
    const base = path.resolve("inherited-node-cache");
    vi.stubEnv("NODE_COMPILE_CACHE", base);
    compileCache.directory.mockReturnValue(path.join(base, "node-version-leaf"));
    process.argv = ["node", "dist/index.js", ...command];
    await withMockedPlatform("linux", async () => {
      await import("./index.js?foreground-cache" as "./index.js");
    });
    expect(compileCache.respawn).not.toHaveBeenCalled();
    expect(compileCache.enable).toHaveBeenCalledOnce();
    expect(runCliWithExitFinalization).toHaveBeenCalledOnce();
  });

  it.skipIf(!process.execve)("keeps the Gateway PID when scoping an inherited cache", async () => {
    const replacement = new Error("execve boundary");
    const execve = vi.spyOn(process, "execve").mockImplementation(() => {
      throw replacement;
    });
    const base = path.resolve("inherited-node-cache");
    vi.stubEnv("NODE_COMPILE_CACHE", base);
    compileCache.directory.mockReturnValue(path.join(base, "node-version-leaf"));
    process.argv = ["node", "dist/index.js", "gateway", "run"];
    await expect(import("./index.js?gateway-cache-pid" as "./index.js")).rejects.toBe(replacement);
    expect(execve).toHaveBeenCalledWith(
      process.execPath,
      [
        process.execPath,
        ...process.execArgv,
        expect.stringMatching(/[\\/]index\.ts$/),
        "gateway",
        "run",
      ],
      expect.objectContaining({
        NODE_COMPILE_CACHE: expect.stringContaining(path.join(base, "openclaw")),
      }),
    );
    expect(compileCache.respawn).not.toHaveBeenCalled();
    expect(runCliWithExitFinalization).not.toHaveBeenCalled();
  });

  it.each([
    { args: ["status"], fails: false },
    { args: ["update", "admit", "--help"], fails: false },
    { args: ["update", "status"], fails: false },
    { args: ["status"], fails: true },
  ])("completes the lifecycle before CLI startup: $args, fails=$fails", async ({ args, fails }) => {
    process.argv = ["node", "dist/index.js", ...args];
    const calls: string[] = [];
    vi.mocked(existsSync).mockImplementation((value) =>
      String(value).endsWith(".openclaw-lifecycle-pending"),
    );
    vi.mocked(completePendingPackageLifecycle).mockImplementation(async () => {
      calls.push("lifecycle");
      if (fails) {
        throw new Error("postinstall failed");
      }
      return true;
    });
    vi.mocked(tryHandleRootVersionFastPath).mockImplementation(() => {
      calls.push("version");
      return false;
    });
    const entry = import("./index.js?pending-package-lifecycle" as "./index.js");
    if (fails) {
      await expect(entry).rejects.toThrow("package lifecycle is incomplete");
      expect(tryHandleRootVersionFastPath).not.toHaveBeenCalled();
    } else {
      await entry;
      expect(calls).toEqual(["lifecycle", "version"]);
    }
    expect(completePendingPackageLifecycle).toHaveBeenCalledOnce();
  });

  it.each([
    [],
    ["--context", "relative/context.json"],
    ["--context", "/private/fixture/admission.json"],
    ["--context", "/private/fixture/admission.json", "extra"],
  ])(
    "leaves pending lifecycle untouched before internal context validation (%j)",
    async (...args) => {
      process.argv = ["node", "dist/index.js", "update", "admit", ...args];
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", "inherited-authority");
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(existsSync).mockImplementation((value) =>
        String(value).endsWith(".openclaw-lifecycle-pending"),
      );
      vi.mocked(completePendingPackageLifecycle).mockRejectedValue(new Error("lifecycle sentinel"));

      await import("./index.js?admission-before-lifecycle" as "./index.js");

      expect(completePendingPackageLifecycle).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledOnce();
      const exitFinalization = await import("./cli/one-shot-exit.js");
      expect(exitFinalization.runCliWithExitFinalization).not.toHaveBeenCalled();
    },
  );
});
