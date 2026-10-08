// Windows schtasks exec tests cover scheduled task command execution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { execSchtasks } from "./schtasks-exec.js";
import { isRegisteredScheduledTask } from "./schtasks-runtime.js";
import * as authority from "./service-update-authority.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeout(...args),
}));

beforeEach(() => {
  runCommandWithTimeout.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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
    { termination: "timeout", detail: "schtasks /Change /DISABLE timed out after 15000ms" },
    {
      termination: "no-output-timeout",
      detail: "schtasks /Change /DISABLE produced no output for 30000ms",
    },
    {
      termination: "signal",
      detail: "schtasks /Change /DISABLE terminated before confirmed completion",
    },
  ] as const)(
    "maps $termination into a non-zero lifecycle result",
    async ({ termination, detail }) => {
      runCommandWithTimeout.mockResolvedValue({
        stdout: "",
        stderr: "",
        code: null,
        signal: "SIGTERM",
        killed: true,
        termination,
      });

      await expect(
        execSchtasks(["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"]),
      ).resolves.toEqual({
        stdout: "",
        stderr: detail,
        code: 124,
      });
      await expect(isRegisteredScheduledTask({})).resolves.toBe(false);
    },
  );

  it("retains lifecycle fallback for ordinary registration failures", async () => {
    runCommandWithTimeout.mockRejectedValue(new Error("synthetic spawn failure"));
    await expect(isRegisteredScheduledTask({})).resolves.toBe(false);
    expect(runCommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
      ["schtasks", "/Query", "/TN", "OpenClaw Gateway"],
      expect.objectContaining({ timeoutMs: 15_000, noOutputTimeoutMs: 30_000 }),
    );
  });

  it.each([
    { cap: 125.75, timeout: 125, noOutput: 125 },
    { cap: 60_000, timeout: 15_000, noOutput: 30_000 },
  ])(
    "caps inspection timers without extending defaults: $cap",
    async ({ cap, timeout, noOutput }) => {
      for (const termination of ["timeout", "no-output-timeout"] as const) {
        runCommandWithTimeout.mockResolvedValue({
          stdout: "",
          stderr: "",
          code: null,
          termination,
        });
        await expect(execSchtasks(["/Query"], cap)).resolves.toEqual({
          stdout: "",
          code: 124,
          stderr:
            termination === "timeout"
              ? `schtasks /Query timed out after ${timeout}ms`
              : `schtasks /Query produced no output for ${noOutput}ms`,
        });
        expect(runCommandWithTimeout).toHaveBeenLastCalledWith(["schtasks", "/Query"], {
          baseEnv: expect.any(Object),
          timeoutMs: timeout,
          noOutputTimeoutMs: noOutput,
        });
      }
    },
  );

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not start a native query with exhausted or invalid allowance %s",
    async (cap) => {
      runCommandWithTimeout.mockResolvedValue({
        stdout: "",
        stderr: "",
        code: 0,
        termination: "exit",
      });
      await expect(execSchtasks(["/Query"], cap)).resolves.toMatchObject({ code: 124 });
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
    },
  );

  it("does not hide revoked update authority behind an exhausted inspection budget", async () => {
    const revoked = new Error("fixture update authority closed");
    vi.spyOn(authority, "assertGatewayServiceUpdateCurrent").mockImplementation(() => {
      throw revoked;
    });
    await expect(execSchtasks(["/Query"], 0)).rejects.toBe(revoked);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("retains cleanup failure identity for a capped query", async () => {
    const cleanup = new CommandProcessCleanupError();
    runCommandWithTimeout.mockRejectedValue(cleanup);
    await expect(execSchtasks(["/Query"], 100)).rejects.toBe(cleanup);
  });

  it("propagates registration cleanup uncertainty rather than allowing lifecycle fallback", async () => {
    const cleanup = new CommandProcessCleanupError();
    runCommandWithTimeout.mockRejectedValue(cleanup);
    await expect(isRegisteredScheduledTask({})).rejects.toBe(cleanup);
  });
});
