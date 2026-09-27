// Windows schtasks exec tests cover scheduled task command execution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSchtasks } from "./schtasks-exec.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeout(...args),
}));

beforeEach(() => {
  runCommandWithTimeout.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("execSchtasks", () => {
  it("runs schtasks with bounded timeouts", async () => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
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
      baseEnv: expect.any(Object),
      timeoutMs: 15_000,
      noOutputTimeoutMs: 30_000,
    });
    expect(runCommandWithTimeout.mock.calls[0]?.[1].baseEnv).not.toHaveProperty(
      "BOUNDARY_PARENT_ONLY",
    );
  });

  it.each([
    { allowance: 700, enforced: 700 },
    { allowance: 699.5, enforced: 699 },
    { allowance: 1, enforced: 1 },
    { allowance: 20_000, enforced: 15_000 },
  ])(
    "bounds explicit inspection allowance $allowance without raising the native cap",
    async ({ allowance, enforced }) => {
      runCommandWithTimeout.mockResolvedValue({
        stdout: "",
        stderr: "",
        code: null,
        signal: "SIGTERM",
        killed: true,
        termination: "timeout",
      });

      await expect(execSchtasks(["/Query"], allowance)).resolves.toEqual({
        stdout: "",
        stderr: `schtasks timed out after ${enforced}ms`,
        code: 124,
      });
      expect(runCommandWithTimeout).toHaveBeenCalledWith(["schtasks", "/Query"], {
        baseEnv: expect.any(Object),
        timeoutMs: enforced,
        noOutputTimeoutMs: enforced,
      });
    },
  );

  it.each([0, -1, 0.75, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not replace unavailable allowance %s with the control default or a longer timer",
    async (allowance) => {
      await expect(execSchtasks(["/Query"], allowance)).rejects.toThrow(
        "inspection deadline expired",
      );
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
    },
  );

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
