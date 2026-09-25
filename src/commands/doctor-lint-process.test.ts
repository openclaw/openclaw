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
  { name: "Windows taskkill", code: 1, signal: null },
  { name: "POSIX kill", code: null, signal: "SIGKILL" as const },
])("accepts its bounded disposal termination with a $name result", async ({ code, signal }) => {
  vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
    assert(typeof options !== "number" && options.signal);
    const abortSignal = options.signal;
    const stopped = new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    options.onOutputChunk?.(Buffer.from(report), "stdout");
    await stopped;
    return {
      stdout: report,
      stderr: "",
      code,
      signal,
      killed: false,
      killIssuedByAbort: true,
      cleanup: "forced",
      termination: "signal",
    };
  });
  const completion = runUpdateDoctorLintProcess({ json: true }, 0);
  await expect(completion).resolves.toBe(0);
  expect(stdout).toHaveBeenCalledWith(report);
  expect(stderr).toHaveBeenCalledWith(
    expect.stringMatching(
      /\[warning\] Doctor disposal timed out after \d+ms; checks completed\.\n/,
    ),
  );
});

it.each([
  {
    name: "nonzero exit before deadline",
    code: 7,
    signal: null,
    termination: "exit",
    elapsed: false,
  },
  {
    name: "nonzero exit after deadline",
    code: 7,
    signal: null,
    termination: "exit",
    elapsed: true,
  },
  {
    name: "independent signal after deadline",
    code: null,
    signal: "SIGTERM",
    termination: "signal",
    elapsed: true,
  },
] as const)(
  "rejects $name without an accepted supervisor abort",
  async ({ code, signal, termination, elapsed }) => {
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
      assert(typeof options !== "number");
      options.onOutputChunk?.(Buffer.from(report), "stdout");
      return {
        stdout: report,
        stderr: "",
        code,
        signal,
        killed: false,
        cleanup: "forced",
        termination,
      };
    });
    await expect(runUpdateDoctorLintProcess({ json: true }, elapsed ? 0 : undefined)).resolves.toBe(
      2,
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("exited unexpectedly"));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("[warning] Doctor disposal"));
  },
);

it.each(["caller", "signal barrier", "combined"])(
  "preserves %s cancellation after the disposal deadline",
  async (mode) => {
    const caller = new AbortController();
    vi.mocked(resolveCommandProcessSignal).mockReturnValue(caller.signal);
    const worker = createDeferredCore<SpawnResult>();
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation((_argv, options) => {
      assert(typeof options !== "number");
      options.onOutputChunk?.(Buffer.from(report), "stdout");
      return worker.promise;
    });
    const completion = runUpdateDoctorLintProcess({ json: true }, 0);
    const cancellation = mode === "caller" ? caller.abort() : waitForSignalExitBarriers();
    if (mode === "combined") {
      caller.abort(new Error("private caller reason"));
      process.stdout.emit("error", new Error("private output token=synthetic-doctor-secret"));
    }
    await nextTurn();
    worker.resolve({
      stdout: report,
      stderr: "",
      code: 1,
      signal: null,
      killed: false,
      killIssuedByAbort: true,
      cleanup: mode === "combined" ? "uncertain" : "forced",
      termination: mode === "combined" ? "no-output-timeout" : "signal",
      ...(mode === "combined" ? { outputErrorStream: "stderr", outputLimitExceeded: true } : {}),
    });
    await cancellation;
    await expect(completion).resolves.toBe(2);
    const reason =
      mode === "combined"
        ? "Doctor lint settlement refused: signal-barrier,caller-signal,output-error,worker-output,output-limit,cleanup-uncertain; disposal-requested,kill-issued-by-abort,termination=no-output-timeout."
        : `Doctor lint settlement refused: ${mode === "caller" ? "caller-signal" : "signal-barrier"}; disposal-requested,kill-issued-by-abort,termination=signal.`;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(report);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(`[openclaw] Reason: ${reason}\n`);
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("[warning] Doctor disposal"));
  },
);

it.each([
  { name: "output-error", output: true, stream: false, cap: false, cleanup: false },
  { name: "worker-output", output: false, stream: true, cap: false, cleanup: false },
  { name: "output-limit", output: false, stream: false, cap: true, cleanup: false },
  { name: "cleanup-uncertain", output: false, stream: false, cap: false, cleanup: true },
  {
    name: "output-error,worker-output,output-limit,cleanup-uncertain",
    output: true,
    stream: true,
    cap: true,
    cleanup: true,
  },
])("reports observed settlement refusal $name without private output", async (failure) => {
  const worker = createDeferredCore<SpawnResult>();
  vi.mocked(runUtf8CommandWithTimeout).mockImplementation((_argv, options) => {
    assert(typeof options !== "number");
    options.onOutputChunk?.(Buffer.from(report), "stdout");
    return worker.promise;
  });
  const completion = runUpdateDoctorLintProcess({ json: true }, 0);
  if (failure.output) {
    process.stdout.emit("error", new Error("private output token=synthetic-doctor-secret"));
  }
  worker.resolve({
    stdout: report,
    stderr: "private worker details",
    code: 0,
    signal: null,
    killed: false,
    killIssuedByAbort: true,
    cleanup: failure.cleanup ? "uncertain" : "forced",
    termination: "no-output-timeout",
    ...(failure.stream ? { outputErrorStream: "stderr" } : {}),
    outputLimitExceeded: failure.cap,
  });
  await expect(completion).resolves.toBe(2);
  const reason = `Doctor lint settlement refused: ${failure.name}; disposal-requested,kill-issued-by-abort,termination=no-output-timeout.`;
  expect(reason.length).toBeLessThanOrEqual(200);
  expect(stdout).toHaveBeenCalledExactlyOnceWith(report);
  expect(stderr).toHaveBeenCalledExactlyOnceWith(`[openclaw] Reason: ${reason}\n`);
});

it.each(["output-error", "caller-signal", "signal-barrier"] as const)(
  "reports %s after readiness output drains without another envelope",
  async (failure) => {
    const caller = new AbortController();
    vi.mocked(resolveCommandProcessSignal).mockReturnValue(caller.signal);
    const draining = createDeferredCore<() => void>();
    vi.mocked(drainProcessOutput).mockImplementation((done) => draining.resolve(done));
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
      assert(typeof options !== "number");
      options.onOutputChunk?.(Buffer.from(report), "stdout");
      return {
        stdout: report,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        cleanup: "normal",
        termination: "exit",
      };
    });
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
