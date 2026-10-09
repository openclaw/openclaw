// Tests executable behavior for the legacy package entrypoint.
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isMainModule } from "./infra/is-main.js";
import { completePendingPackageLifecycle } from "./infra/package-lifecycle.js";

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(isMainModule).mockReturnValue(true);
    vi.mocked(tryHandleRootVersionFastPath).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(completePendingPackageLifecycle).mockResolvedValue(true);
    lifecycleImports.failureOutput.mockClear();
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
