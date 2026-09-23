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
import { createDeferredCore } from "../shared/deferred.js";
import { runUpdateDoctorLintProcess } from "./doctor-lint-process.js";

vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: vi.fn() }));
vi.mock("../process/exec-spawn.js", () => ({ resolveCommandProcessSignal: vi.fn() }));
vi.mock("../process/output-drain.js", () => ({ drainProcessOutput: (done: () => void) => done() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const report = `${JSON.stringify({ ok: true, checksRun: 1, findings: [] })}\n`;
let stdout: MockInstance<typeof process.stdout.write>;
let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
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

it.each(["caller", "signal barrier"])(
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
    const cancellation = mode === "signal barrier" ? waitForSignalExitBarriers() : caller.abort();
    await nextTurn();
    worker.resolve({
      stdout: report,
      stderr: "",
      code: 1,
      signal: null,
      killed: false,
      killIssuedByAbort: true,
      cleanup: "forced",
      termination: "signal",
    });
    await cancellation;
    await expect(completion).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("did not complete"));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("[warning] Doctor disposal"));
  },
);
