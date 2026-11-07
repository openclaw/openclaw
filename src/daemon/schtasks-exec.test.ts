import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { execScheduledTaskEnabledChange, execSchtasks } from "./schtasks-exec.js";
import { isRegisteredScheduledTask } from "./schtasks-runtime.js";

const { runCommandWithTimeout, diagnosticLog } = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
  diagnosticLog: vi.fn(),
}));

// mock-isolation: Exercise real daemon result handling without spawning native commands.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout }));
// mock-isolation: Observe diagnostic messages while exercising the real timing owner.
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "update/diagnostics"
        ? {
            ...logger,
            debug: (message: string) => diagnosticLog("debug", message),
            warn: (message: string) => diagnosticLog("warn", message),
          }
        : logger;
    },
  };
});

beforeEach(() => {
  runCommandWithTimeout.mockReset();
  diagnosticLog.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

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

it("warns about an in-flight task stop before native settlement without private arguments", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  let complete!: (result: ReturnType<typeof createCommandResult>) => void;
  runCommandWithTimeout.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const operation = execSchtasks(["/End", "/TN", "synthetic-private-task-token"]);
  expect(diagnosticLog.mock.calls).toHaveLength(1);
  const begun = JSON.parse((diagnosticLog.mock.calls[0]?.[1] ?? "").slice("update-phase ".length));
  expect(begun).toMatchObject({ phase: "schtasks-end", event: "start", elapsedMs: 0 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(diagnosticLog.mock.calls[1]?.[0]).toBe("warn");
  expect(
    JSON.parse((diagnosticLog.mock.calls[1]?.[1] ?? "").slice("update-phase ".length)),
  ).toMatchObject({
    phase: "schtasks-end",
    event: "slow",
    elapsedMs: 30_000,
  });
  complete(createCommandResult({ code: 124, termination: "timeout" }));
  await expect(operation).resolves.toMatchObject({ code: 124 });
  const ended = JSON.parse((diagnosticLog.mock.calls[2]?.[1] ?? "").slice("update-phase ".length));
  expect(ended).toMatchObject({
    phase: "schtasks-end",
    event: "end",
    code: 124,
    termination: "timeout",
  });
  expect(ended.elapsedMs).toBe(30_000);
  expect(JSON.stringify(diagnosticLog.mock.calls)).not.toContain("synthetic-private-task-token");
});
