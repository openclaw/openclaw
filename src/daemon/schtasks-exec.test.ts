import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { execScheduledTaskEnabledChange, execSchtasks } from "./schtasks-exec.js";
import { isRegisteredScheduledTask } from "./schtasks-runtime.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

// mock-isolation: Exercise real daemon result handling without spawning native commands.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout }));

beforeEach(() => {
  runCommandWithTimeout.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["-2147024891\r\n", "exit", -2147024891],
  ["", "exit", undefined],
  ["-2147024891 trailing diagnostic", "exit", undefined],
  ["-2147483649", "exit", undefined],
  ["-2147024891", "timeout", undefined],
] as const)("retains confirmed HRESULT: %s (%s)", async (stdout, termination, hresult) => {
  runCommandWithTimeout.mockResolvedValue(
    createCommandResult({ stdout, code: 1, killed: termination !== "exit", termination }),
  );
  const result = await execScheduledTaskEnabledChange("OpenClaw Gateway", false);
  expect(result.code).not.toBe(0);
  expect(result.hresult).toBe(hresult);
  expect(runCommandWithTimeout.mock.lastCall?.[1]).toMatchObject({ timeoutMs: 60_000 });
});

it.each([
  ["exit", "ok", 0, ""],
  ["timeout", "", 124, "schtasks /Change /DISABLE timed out after 15000ms"],
  ["signal", "", 124, "schtasks /Change /DISABLE terminated before confirmed completion"],
] as const)(
  "maps %s into a bounded, isolated lifecycle result",
  async (termination, stdout, code, stderr) => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    runCommandWithTimeout.mockResolvedValue(
      createCommandResult({ stdout, code: termination === "exit" ? 0 : null, termination }),
    );
    const result = await execSchtasks(["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"]);
    expect(result).toEqual({ stdout, stderr, code });
    const options = runCommandWithTimeout.mock.lastCall?.[1];
    expect(options.timeoutMs).toBe(15_000);
    expect(options.baseEnv).not.toHaveProperty("BOUNDARY_PARENT_ONLY");
    await expect(isRegisteredScheduledTask({})).resolves.toBe(termination === "exit");
  },
);

it("retains lifecycle fallback for ordinary registration failures", async () => {
  runCommandWithTimeout.mockRejectedValue(new Error("synthetic spawn failure"));
  await expect(isRegisteredScheduledTask({})).resolves.toBe(false);
});

it("propagates registration cleanup uncertainty rather than allowing lifecycle fallback", async () => {
  const cleanup = new CommandProcessCleanupError();
  runCommandWithTimeout.mockRejectedValue(cleanup);
  await expect(isRegisteredScheduledTask({})).rejects.toBe(cleanup);
});
