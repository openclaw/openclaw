import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeout(...args),
}));

const { execSchtasks } = await import("./schtasks-exec.js");

beforeEach(() => {
  runCommandWithTimeout.mockReset();
});

describe("execSchtasks", () => {
  it("runs schtasks with bounded timeouts", async () => {
    runCommandWithTimeout.mockResolvedValue({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(execSchtasks(["/Query"])).resolves.toEqual({
      stdout: "ok",
      stderr: "",
      code: 0,
    });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(["schtasks", "/Query"], {
      timeoutMs: 15_000,
      noOutputTimeoutMs: 5_000,
    });
  });

  it("maps a timeout into a non-zero schtasks result", async () => {
    runCommandWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: null,
      signal: "SIGTERM",
      killed: true,
      termination: "timeout",
    });

    await expect(execSchtasks(["/Create"])).resolves.toEqual({
      stdout: "",
      stderr: "schtasks timed out after 15000ms",
      code: 124,
    });
  });
});
