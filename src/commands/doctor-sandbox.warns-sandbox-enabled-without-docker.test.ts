import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const runExec = vi.fn();
const note = vi.fn();

vi.mock("../process/exec.js", () => ({
  runExec,
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => ({
  DEFAULT_SANDBOX_BROWSER_IMAGE: "browser-image",
  DEFAULT_SANDBOX_COMMON_IMAGE: "common-image",
  DEFAULT_SANDBOX_IMAGE: "default-image",
  resolveSandboxScope: vi.fn(() => "shared"),
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

const { maybeRepairSandboxImages } = await import("./doctor-sandbox.js");

describe("maybeRepairSandboxImages", () => {
  const mockRuntime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  const mockPrompter: DoctorPrompter = {
    confirmSkipInNonInteractive: vi.fn().mockResolvedValue(false),
  } as unknown as DoctorPrompter;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createSandboxConfig(mode: "off" | "all" | "non-main"): OpenClawConfig {
    return {
      agents: {
        defaults: {
          sandbox: {
            mode,
          },
        },
      },
    };
  }

  async function runSandboxRepair(params: {
    mode: "off" | "all" | "non-main";
    dockerAvailable: boolean;
  }) {
    if (params.dockerAvailable) {
      runExec.mockResolvedValue({ stdout: "24.0.0", stderr: "" });
    } else {
      runExec.mockRejectedValue(new Error("Docker not installed"));
    }
    await maybeRepairSandboxImages(createSandboxConfig(params.mode), mockRuntime, mockPrompter);
  }

  it("warns when sandbox mode is enabled but Docker is not available", async () => {
    await runSandboxRepair({ mode: "non-main", dockerAvailable: false });

    // The warning should clearly indicate sandbox is enabled but won't work
    expect(note).toHaveBeenCalled();
    const noteCall = note.mock.calls[0];
    const message = noteCall[0] as string;

    // The message should warn that sandbox mode won't function, not just "skipping checks"
    expect(message).toMatch(/sandbox.*mode.*enabled|sandbox.*won.*work|docker.*required/i);
    // Should NOT just say "skipping sandbox image checks" - that's too mild
    expect(message).not.toBe("Docker not available; skipping sandbox image checks.");
  });

  it("warns when sandbox mode is 'all' but Docker is not available", async () => {
    await runSandboxRepair({ mode: "all", dockerAvailable: false });

    expect(note).toHaveBeenCalled();
    const noteCall = note.mock.calls[0];
    const message = noteCall[0] as string;

    // Should warn about the impact on sandbox functionality
    expect(message).toMatch(/sandbox|docker/i);
  });

  it("does not warn when sandbox mode is off", async () => {
    await runSandboxRepair({ mode: "off", dockerAvailable: false });

    // No warning needed when sandbox is off
    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when Docker is available", async () => {
    await runSandboxRepair({ mode: "non-main", dockerAvailable: true });

    // May have other notes about images, but not the Docker unavailable warning
    const dockerUnavailableWarning = note.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].toLowerCase().includes("docker not available"),
    );
    expect(dockerUnavailableWarning).toBeUndefined();
  });
});
