import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import type { SpawnResult } from "../process/exec-result.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { drainProcessOutput } from "../process/output-drain.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runUpdateDoctorLintProcess } from "./doctor-lint-process.js";

vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: vi.fn() }));
vi.mock("../process/exec-spawn.js", () => ({ resolveCommandProcessSignal: vi.fn() }));
vi.mock("../process/output-drain.js", () => ({ drainProcessOutput: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const report = `${JSON.stringify({ ok: true, checksRun: 1, findings: [] })}\n`;
let stdout: MockInstance<typeof process.stdout.write>;
let stderr: MockInstance<typeof process.stderr.write>;

function workerResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: report,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    cleanup: "normal",
    termination: "exit",
    ...overrides,
  };
}

function reportingWorker(result: SpawnResult | Promise<SpawnResult> = workerResult()) {
  vi.mocked(runUtf8CommandWithTimeout).mockImplementation((_argv, options) => {
    assert(typeof options !== "number");
    options.onOutputChunk?.(Buffer.from(report), "stdout");
    return Promise.resolve(result);
  });
}

function expectRefusal(reason: string) {
  expect(reason.length).toBeLessThanOrEqual(200);
  expect(stdout).toHaveBeenCalledExactlyOnceWith(report);
  expect(stderr).toHaveBeenCalledExactlyOnceWith(`[openclaw] Reason: ${reason}\n`);
}

beforeEach(() => {
  vi.mocked(drainProcessOutput).mockImplementation((done) => done());
  for (const [key, value] of Object.entries({
    ...buildUpdateRehearsalPathEnv(tempDirs.make("doctor-lint-supervisor-")),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
    OPENCLAW_UPDATE_IN_PROGRESS: "0",
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  })) {
    vi.stubEnv(key, value);
  }
  stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each([
  ["Windows taskkill", 1, null],
  ["POSIX kill", null, "SIGKILL"],
] as const)(
  "accepts its bounded disposal termination with a %s result",
  async (_name, code, signal) => {
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
      assert(typeof options !== "number" && options.signal);
      const stopped = createDeferredCore();
      options.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
      options.onOutputChunk?.(Buffer.from(report), "stdout");
      await stopped.promise;
      return workerResult({
        code,
        signal,
        killIssuedByAbort: true,
        cleanup: "forced",
        termination: "signal",
      });
    });
    const completion = runUpdateDoctorLintProcess({ json: true }, { disposalDeadlineMs: 0 });
    await expect(completion).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(report);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[warning\] Doctor disposal timed out after \d+ms; checks completed\.\n/,
      ),
    );
  },
);

it("hands the worker this command's budget anchor", async () => {
  let input: string | undefined;
  vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
    assert(typeof options !== "number" && typeof options.input === "string");
    input = options.input;
    options.onOutputChunk?.(Buffer.from(report), "stdout");
    return workerResult();
  });
  await expect(
    runUpdateDoctorLintProcess({ json: true }, { commandStartedAtMs: 1_234 }),
  ).resolves.toBe(0);
  expect(JSON.parse(input ?? "")).toEqual({ options: { json: true }, commandStartedAtMs: 1_234 });
});

it.each([
  ["nonzero exit after deadline", 7, null, "exit"],
  ["independent signal after deadline", null, "SIGTERM", "signal"],
] as const)(
  "rejects %s without an accepted supervisor abort",
  async (_name, code, signal, termination) => {
    reportingWorker(workerResult({ code, signal, cleanup: "forced", termination }));
    await expect(
      runUpdateDoctorLintProcess({ json: true }, { disposalDeadlineMs: 0 }),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("exited unexpectedly"));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("[warning] Doctor disposal"));
  },
);

it.each([
  "caller-signal",
  "signal-barrier",
  "combined",
  "output-error",
  "worker-output",
  "output-limit",
  "cleanup-uncertain",
] as const)("reports settlement refusal %s without private output", async (mode) => {
  const caller = new AbortController();
  const cancelled = mode === "caller-signal" || mode === "signal-barrier" || mode === "combined";
  if (cancelled) {
    vi.mocked(resolveCommandProcessSignal).mockReturnValue(caller.signal);
  }
  const worker = createDeferredCore<SpawnResult>();
  reportingWorker(worker.promise);
  const completion = runUpdateDoctorLintProcess({ json: true }, { disposalDeadlineMs: 0 });
  const cancellation =
    mode === "caller-signal"
      ? caller.abort()
      : mode === "signal-barrier" || mode === "combined"
        ? waitForSignalExitBarriers()
        : undefined;
  if (mode === "combined") {
    caller.abort(new Error("private caller reason"));
  }
  if (mode === "combined" || mode === "output-error") {
    process.stdout.emit("error", new Error("private output token=synthetic-doctor-secret"));
  }
  if (cancelled) {
    await nextTurn();
  }
  worker.resolve(
    workerResult({
      code: cancelled ? 1 : 0,
      stderr: cancelled ? "" : "private worker details",
      killIssuedByAbort: true,
      cleanup: mode === "combined" || mode === "cleanup-uncertain" ? "uncertain" : "forced",
      termination: cancelled && mode !== "combined" ? "signal" : "no-output-timeout",
      ...(mode === "combined" || mode === "worker-output" ? { outputErrorStream: "stderr" } : {}),
      ...(!cancelled || mode === "combined"
        ? { outputLimitExceeded: mode === "combined" || mode === "output-limit" }
        : {}),
    }),
  );
  await cancellation;
  await expect(completion).resolves.toBe(2);
  const reason =
    mode === "combined"
      ? "Doctor lint settlement refused: signal-barrier,caller-signal,output-error,worker-output,output-limit,cleanup-uncertain; disposal-requested,kill-issued-by-abort,termination=no-output-timeout."
      : `Doctor lint settlement refused: ${mode}; disposal-requested,kill-issued-by-abort,termination=${cancelled ? "signal" : "no-output-timeout"}.`;
  expectRefusal(reason);
  if (cancelled) {
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("[warning] Doctor disposal"));
  }
});

it.each(["output-error", "caller-signal", "signal-barrier"] as const)(
  "reports %s after readiness output drains without another envelope",
  async (failure) => {
    const caller = new AbortController();
    vi.mocked(resolveCommandProcessSignal).mockReturnValue(caller.signal);
    const draining = createDeferredCore<() => void>();
    vi.mocked(drainProcessOutput).mockImplementation((done) => draining.resolve(done));
    reportingWorker();
    const completion = runUpdateDoctorLintProcess({ json: true });
    const drained = await draining.promise;
    if (failure === "output-error") {
      process.stderr.emit("error", new Error("private output token=synthetic-doctor-secret"));
    } else if (failure === "caller-signal") {
      caller.abort(new Error("private caller reason"));
    } else {
      await waitForSignalExitBarriers();
    }
    drained();
    await expect(completion).resolves.toBe(2);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(report);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      `[openclaw] Reason: Doctor lint output-drain refused: ${failure}.\n`,
    );
  },
);
