import { afterEach, describe, expect, it, vi } from "vitest";

const completionMocks = vi.hoisted(() => ({
  uninstallCompletionFromAllProfiles: vi.fn(async () => [] as string[]),
}));

vi.mock("../cli/completion-cli.js", () => ({
  uninstallCompletionFromAllProfiles: completionMocks.uninstallCompletionFromAllProfiles,
}));

vi.mock("../cli/cli-name.js", () => ({
  resolveCliName: () => "openclaw",
}));

const configMocks = vi.hoisted(() => ({
  isNixMode: false,
  loadConfig: vi.fn(() => ({})),
  resolveConfigPath: vi.fn(() => "/tmp/openclaw/openclaw.json"),
  resolveOAuthDir: vi.fn(() => "/tmp/openclaw/credentials"),
  resolveStateDir: vi.fn(() => "/tmp/openclaw"),
}));

vi.mock("../config/config.js", () => configMocks);

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    notLoadedText: "not loaded",
    isLoaded: vi.fn(async () => false),
    stop: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
  })),
}));

const cleanupMocks = vi.hoisted(() => ({
  collectWorkspaceDirs: vi.fn(() => [] as string[]),
  isPathWithin: vi.fn(() => false),
  removePath: vi.fn(async () => {}),
}));

vi.mock("./cleanup-utils.js", () => cleanupMocks);

vi.mock("../utils.js", () => ({
  resolveHomeDir: () => "/tmp",
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("uninstallCommand completion cleanup", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("cleans shell completion profile entries when uninstalling state", async () => {
    completionMocks.uninstallCompletionFromAllProfiles.mockResolvedValueOnce(["zsh"]);
    const runtime = createRuntime();
    const { uninstallCommand } = await import("./uninstall.js");

    await uninstallCommand(runtime as never, {
      state: true,
      nonInteractive: true,
      yes: true,
    });

    expect(completionMocks.uninstallCompletionFromAllProfiles).toHaveBeenCalledWith("openclaw");
    expect(runtime.log).toHaveBeenCalledWith("Removed shell completion from: zsh");
    expect(cleanupMocks.removePath).toHaveBeenCalledWith("/tmp/openclaw", runtime, {
      dryRun: false,
      label: "/tmp/openclaw",
    });
  });

  it("reports completion cleanup in dry-run mode without changing profiles", async () => {
    const runtime = createRuntime();
    const { uninstallCommand } = await import("./uninstall.js");

    await uninstallCommand(runtime as never, {
      state: true,
      nonInteractive: true,
      yes: true,
      dryRun: true,
    });

    expect(completionMocks.uninstallCompletionFromAllProfiles).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "[dry-run] remove shell completion entries from profiles",
    );
  });
});
