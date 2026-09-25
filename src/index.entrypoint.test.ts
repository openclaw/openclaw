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
vi.mock("./cli/one-shot-exit.js", () => ({
  runCliWithExitFinalization: vi.fn(),
}));
vi.mock("./entry.version-fast-path.js", () => ({
  tryHandleRootVersionFastPath: vi.fn(() => false),
}));
vi.mock("./infra/is-main.js", () => ({
  isMainModule: vi.fn(() => true),
}));
vi.mock("./infra/package-lifecycle.js", () => ({
  completePendingPackageLifecycle: vi.fn(async () => true),
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
    process.argv = ["node", "dist/index.js", "status"];
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("handles root --version before CLI startup", async () => {
    process.argv = ["node", "dist/index.js", "--version"];
    vi.mocked(tryHandleRootVersionFastPath).mockReturnValue(true);

    await import("./index.js?legacy-version-fast-path" as "./index.js");

    const runMain = await import("./cli/run-main.js");
    const exitFinalization = await import("./cli/one-shot-exit.js");
    expect(tryHandleRootVersionFastPath).toHaveBeenCalledWith(process.argv);
    expect(runMain.runCli).not.toHaveBeenCalled();
    expect(exitFinalization.runCliWithExitFinalization).not.toHaveBeenCalled();
  });

  it("completes pending lifecycle before loading the CLI entry graph", async () => {
    const calls: string[] = [];
    vi.mocked(existsSync).mockImplementation((value) =>
      String(value).endsWith(".openclaw-lifecycle-pending"),
    );
    vi.mocked(completePendingPackageLifecycle).mockImplementation(async () => {
      calls.push("lifecycle");
      return true;
    });
    vi.mocked(tryHandleRootVersionFastPath).mockImplementation(() => {
      calls.push("version");
      return false;
    });

    await import("./index.js?pending-package-lifecycle" as "./index.js");

    expect(completePendingPackageLifecycle).toHaveBeenCalledOnce();
    expect(calls).toEqual(["lifecycle", "version"]);
  });

  it("does not load the CLI entry graph when lifecycle completion fails", async () => {
    vi.mocked(existsSync).mockImplementation((value) =>
      String(value).endsWith(".openclaw-lifecycle-pending"),
    );
    vi.mocked(completePendingPackageLifecycle).mockRejectedValue(new Error("postinstall failed"));

    await expect(import("./index.js?failed-package-lifecycle" as "./index.js")).rejects.toThrow(
      "package lifecycle is incomplete",
    );
    expect(tryHandleRootVersionFastPath).not.toHaveBeenCalled();
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

  it.each([
    ["update", "admit", "--help"],
    ["update", "status"],
  ])("retains lifecycle completion for ordinary argv %j", async (...args) => {
    process.argv = ["node", "dist/index.js", ...args];
    vi.mocked(existsSync).mockImplementation((value) =>
      String(value).endsWith(".openclaw-lifecycle-pending"),
    );
    await import("./index.js?ordinary-lifecycle" as "./index.js");
    expect(completePendingPackageLifecycle).toHaveBeenCalledOnce();
  });
});
