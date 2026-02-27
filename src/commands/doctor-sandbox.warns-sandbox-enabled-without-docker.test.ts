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

vi.mock("../terminal/note.js", () => ({
  note,
}));

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

  it("warns when sandbox mode is enabled but Docker is not available", async () => {
    // Simulate Docker not available (command fails)
    runExec.mockRejectedValue(new Error("Docker not installed"));

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",
          },
        },
      },
    };

    const { maybeRepairSandboxImages } = await import("./doctor-sandbox.js");
    await maybeRepairSandboxImages(config, mockRuntime, mockPrompter);

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
    runExec.mockRejectedValue(new Error("Docker not installed"));

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
          },
        },
      },
    };

    const { maybeRepairSandboxImages } = await import("./doctor-sandbox.js");
    await maybeRepairSandboxImages(config, mockRuntime, mockPrompter);

    expect(note).toHaveBeenCalled();
    const noteCall = note.mock.calls[0];
    const message = noteCall[0] as string;

    // Should warn about the impact on sandbox functionality
    expect(message).toMatch(/sandbox|docker/i);
  });

  it("does not warn when sandbox mode is off", async () => {
    runExec.mockRejectedValue(new Error("Docker not installed"));

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "off",
          },
        },
      },
    };

    const { maybeRepairSandboxImages } = await import("./doctor-sandbox.js");
    await maybeRepairSandboxImages(config, mockRuntime, mockPrompter);

    // No warning needed when sandbox is off
    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when Docker is available", async () => {
    // Simulate Docker available
    runExec.mockResolvedValue({ stdout: "24.0.0", stderr: "" });

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",
          },
        },
      },
    };

    const { maybeRepairSandboxImages } = await import("./doctor-sandbox.js");
    await maybeRepairSandboxImages(config, mockRuntime, mockPrompter);

    // May have other notes about images, but not the Docker unavailable warning
    const dockerUnavailableWarning = note.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].toLowerCase().includes("docker not available"),
    );
    expect(dockerUnavailableWarning).toBeUndefined();
  });
});
