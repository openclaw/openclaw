// Windows schtasks exec tests cover scheduled task command execution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { execScheduledTaskEnabledChange, execSchtasks } from "./schtasks-exec.js";
import { isRegisteredScheduledTask } from "./schtasks-runtime.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeout(...args),
}));

beforeEach(() => {
  runCommandWithTimeout.mockReset();
});

describe("execScheduledTaskEnabledChange", () => {
  it.each([
    { stdout: "-2147024891\r\n", termination: "exit", hresult: -2147024891 },
    { stdout: "-2147024894", termination: "exit", hresult: -2147024894 },
    { stdout: "", termination: "exit", hresult: undefined },
    { stdout: "-2147024891 trailing diagnostic", termination: "exit", hresult: undefined },
    { stdout: "-2147483649", termination: "exit", hresult: undefined },
    { stdout: "-2147024891", termination: "timeout", hresult: undefined },
    { stdout: "-2147024891", termination: "signal", hresult: undefined },
  ] as const)(
    "preserves only a confirmed native HRESULT from $termination: $stdout",
    async ({ stdout, termination, hresult }) => {
      runCommandWithTimeout.mockResolvedValue({
        stdout,
        stderr: "",
        code: 1,
        signal: null,
        killed: termination !== "exit",
        termination,
      });

      const result = await execScheduledTaskEnabledChange("OpenClaw Gateway", false);

      expect(result.code).not.toBe(0);
      expect(result.hresult).toBe(hresult);
      expect(runCommandWithTimeout).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ timeoutMs: 60_000 }),
      );
    },
  );
});

afterEach(() => vi.unstubAllEnvs());

describe("execSchtasks", () => {
  it("runs schtasks with a bounded timeout", async () => {
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
    });
    expect(runCommandWithTimeout.mock.calls[0]?.[1].baseEnv).not.toHaveProperty(
      "BOUNDARY_PARENT_ONLY",
    );
  });

  it.each([
    { termination: "timeout", detail: "schtasks /Change /DISABLE timed out after 15000ms" },
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
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it("propagates registration cleanup uncertainty rather than allowing lifecycle fallback", async () => {
    const cleanup = new CommandProcessCleanupError();
    runCommandWithTimeout.mockRejectedValue(cleanup);
    await expect(isRegisteredScheduledTask({})).rejects.toBe(cleanup);
  });
});
