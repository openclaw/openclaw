import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  runInteractiveOnboarding: vi.fn(async () => {}),
  runNonInteractiveOnboarding: vi.fn(async () => {}),
  readConfigFileSnapshot: vi.fn(async () => ({ exists: false, valid: false, config: {} })),
  handleReset: vi.fn(async () => {}),
}));

vi.mock("./onboard-interactive.js", () => ({
  runInteractiveOnboarding: mocks.runInteractiveOnboarding,
}));

vi.mock("./onboard-non-interactive.js", () => ({
  runNonInteractiveOnboarding: mocks.runNonInteractiveOnboarding,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  handleReset: mocks.handleReset,
}));

const { onboardCommand } = await import("./onboard.js");

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

describe("onboardCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({ exists: false, valid: false, config: {} });
  });

  it("fails fast for invalid secret-input-mode before onboarding starts", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        secretInputMode: "invalid" as never, // pragma: allowlist secret
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      'Invalid --secret-input-mode. Use "plaintext" or "ref".',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runInteractiveOnboarding).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveOnboarding).not.toHaveBeenCalled();
  });

  it("logs ASCII-safe Windows guidance before onboarding", async () => {
    const runtime = makeRuntime();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await onboardCommand({}, runtime);

      expect(runtime.log).toHaveBeenCalledWith(
        [
          "Windows detected - OpenClaw runs great on WSL2!",
          "Native Windows might be trickier.",
          "Quick setup: wsl --install (one command, one reboot)",
          "Guide: https://docs.openclaw.ai/windows",
        ].join("\n"),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("defaults --reset to config+creds+sessions scope", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        reset: true,
      },
      runtime,
    );

    expect(mocks.handleReset).toHaveBeenCalledWith(
      "config+creds+sessions",
      expect.any(String),
      runtime,
    );
  });

  it("uses configured default workspace for --reset when --workspace is not provided", async () => {
    const runtime = makeRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/openclaw-custom-workspace",
          },
        },
      },
    });

    await onboardCommand(
      {
        reset: true,
      },
      runtime,
    );

    expect(mocks.handleReset).toHaveBeenCalledWith(
      "config+creds+sessions",
      path.resolve("/tmp/openclaw-custom-workspace"),
      runtime,
    );
  });

  it("accepts explicit --reset-scope full", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        reset: true,
        resetScope: "full",
      },
      runtime,
    );

    expect(mocks.handleReset).toHaveBeenCalledWith("full", expect.any(String), runtime);
  });

  it("fails fast for invalid --reset-scope", async () => {
    const runtime = makeRuntime();

    await onboardCommand(
      {
        reset: true,
        resetScope: "invalid" as never,
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      'Invalid --reset-scope. Use "config", "config+creds+sessions", or "full".',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runInteractiveOnboarding).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveOnboarding).not.toHaveBeenCalled();
  });
});
