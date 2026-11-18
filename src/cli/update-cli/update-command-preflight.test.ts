import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isUpdateAdmissionAuthorityEnvKey } from "../../infra/update-admission-contract.js";
import type {
  CanaryResult,
  UpdateCandidateCanaryParams,
} from "../../infra/update-candidate-canary-commands.js";
import { cleanupUpdateTemporaryDirectory } from "../../infra/update-maintenance.js";
import { parseUpdateRehearsalEventLine } from "../../infra/update-rehearsal-contract.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { registerUpdateCli } from "../update-cli.js";

const { canary } = vi.hoisted(() => ({ canary: vi.fn() }));
// mock-isolation: tests receipt mapping without spawning the candidate; the built CLI test covers startup.
vi.mock("../../infra/update-candidate-canary.js", () => ({
  validateUpdateCandidateCanary: canary,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const previousExitCode = process.exitCode;
let home: string;

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  home = dirs.make("update-preflight-");
  for (const key of Object.keys(process.env)) {
    if (isUpdateAdmissionAuthorityEnvKey(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, "state", "openclaw.json"));
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function invoke() {
  const program = new Command().exitOverride();
  registerUpdateCli(program);
  await program.parseAsync(["node", "openclaw", "update", "preflight", "--json"]);
}

it.each([
  { status: "ok", phase: "readiness", exitCode: 0, expected: "ready", code: 0 },
  { status: "error", phase: "config", exitCode: 1, expected: "blocked", code: 3 },
  { status: "ok", phase: "runtime", exitCode: undefined, expected: "unverified", code: 2 },
  { status: "ok", phase: "readiness", exitCode: null, expected: "unverified", code: 2 },
] as const)("reports $expected for $status/$phase/$exitCode", async (testCase) => {
  const result: CanaryResult = {
    ...(testCase.status === "error"
      ? { status: "error", reason: "runtime-verification-failed" }
      : { status: "ok" }),
    phase: testCase.phase,
    durationMs: 1,
    logTail: [],
    steps:
      testCase.exitCode === undefined
        ? []
        : [
            {
              name: "candidate-gateway-startup",
              command: "gateway run",
              cwd: ".",
              durationMs: 1,
              exitCode: testCase.exitCode,
            },
          ],
  };
  canary.mockResolvedValue(result);

  await invoke();

  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: 1,
      mode: "preflight",
      status: testCase.expected,
      coverage: "isolated-core-startup",
    }),
  );
  expect(process.exitCode).toBe(testCase.code);
});

it("refuses inherited updater authority before inspecting the profile", async () => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");

  await invoke();

  expect(canary).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: 1,
      mode: "preflight",
      status: "unverified",
      reason: "preflight-execution-failed",
    }),
  );
  expect(process.exitCode).toBe(2);
});

it("emits only an unverified receipt when canary cleanup fails", async () => {
  canary.mockRejectedValue(new Error("Candidate cleanup could not be verified"));

  await invoke();

  expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "unverified",
      reason: "preflight-execution-failed",
    }),
  );
  expect(process.exitCode).toBe(2);
});

const rehearsalProgress: UpdateRunStep = { step: "candidate-doctor", status: "in_progress" };
const rehearsalStep: UpdateStepResult = {
  name: "candidate-doctor",
  command: "doctor --fix",
  cwd: ".",
  durationMs: 1,
  exitCode: 0,
};

type ReceiptAnswer = (seq: number, updater: PassThrough) => void;
const commits: ReceiptAnswer = (seq, updater) =>
  void updater.write(`${JSON.stringify({ seq, ok: true })}\n`);

/** Runs the command against a fixture updater that answers each receipt on stdin. */
async function rehearse(
  request: unknown,
  requestPath = path.join(home, "request.json"),
  answer = commits,
) {
  await fs.writeFile(path.join(home, "request.json"), JSON.stringify(request));
  const updater = new PassThrough();
  // The command only reads lines from stdin; a pipe is what the real updater provides.
  vi.spyOn(process, "stdin", "get").mockReturnValue(updater as unknown as typeof process.stdin);
  const receipts: unknown[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    const event = parseUpdateRehearsalEventLine(String(chunk).trimEnd());
    receipts.push(event);
    if (event && "seq" in event) {
      answer(event.seq, updater);
    }
    return true;
  });
  const program = new Command().exitOverride();
  registerUpdateCli(program);
  await program.parseAsync(["node", "openclaw", "update", "rehearse", "--request", requestPath]);
  return receipts;
}

it.each([
  [{ status: "ok" }, 0],
  [{ status: "error", reason: "doctor-failed" }, 3],
  [{ status: "error", reason: "runtime-verification-failed" }, 3],
] as const)(
  "rehearses the updater's request and answers %j with exit %i",
  async (outcome, code) => {
    const result: CanaryResult = {
      ...outcome,
      phase: "doctor",
      durationMs: 1,
      logTail: [],
      steps: [rehearsalStep],
    };
    canary.mockImplementation(async (params: UpdateCandidateCanaryParams) => {
      await params.onProgress?.(rehearsalProgress);
      await params.onStep?.(rehearsalStep);
      return result;
    });

    const receipts = await rehearse({
      protocol: 1,
      config: { gateway: { port: 18789 } },
      sourceBundledPlugins: { packageRoot: "/serving/openclaw" },
      timeoutMs: 90_000,
      fullIntegrityCheck: true,
    });

    // The candidate rehearses the updater's resolved source, not its own reading of the profile.
    expect(canary).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { gateway: { port: 18789 } },
        sourceBundledPlugins: { packageRoot: "/serving/openclaw" },
        stateDir: path.join(home, "state"),
        timeoutMs: 90_000,
        fullIntegrityCheck: true,
      }),
    );
    expect(receipts).toEqual([
      { type: "progress", seq: 1, step: rehearsalProgress },
      { type: "step", seq: 2, step: rehearsalStep },
    ]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({ protocol: 1, result });
    expect(process.exitCode).toBe(code);
  },
);

it.each([
  [
    "inherited updater authority",
    { protocol: 1, config: {} },
    undefined,
    "OPENCLAW_UPDATE_IN_PROGRESS",
  ],
  ["another protocol", { protocol: 2, config: {} }, undefined, undefined],
  ["a request without a config source", { protocol: 1 }, undefined, undefined],
  ["a relative request path", { protocol: 1, config: {} }, "request.json", undefined],
] as const)(
  "answers %s with no result, leaving the rehearsal to the updater",
  async (...testCase) => {
    const [, request, requestPath, authority] = testCase;
    if (authority) {
      vi.stubEnv(authority, "1");
    }

    await rehearse(request, requestPath);

    expect(canary).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({
      protocol: 1,
      error: "rehearsal-execution-failed",
    });
    expect(process.exitCode).toBe(2);
  },
);

it.each([
  [
    "refuses a receipt",
    ((seq, updater) =>
      void updater.write(`${JSON.stringify({ seq, ok: false })}\n`)) as ReceiptAnswer,
    "refused a rehearsal receipt",
  ],
  [
    "stops answering",
    ((_seq, updater) => void updater.end()) as ReceiptAnswer,
    "stopped answering rehearsal receipts",
  ],
] as const)(
  "does not start the announced check when the updater %s",
  async (_name, answer, message) => {
    const check = vi.fn();
    const copy = dirs.make("update-rehearsal-copy-");
    canary.mockImplementation(async (params: UpdateCandidateCanaryParams) => {
      try {
        await params.onProgress?.(rehearsalProgress);
        check();
      } finally {
        // The canary removes its state copy this way on every exit.
        await cleanupUpdateTemporaryDirectory({
          directory: copy,
          root: home,
          name: "candidate-state-cleanup",
          onProgress: params.onProgress,
          onWarning: (step) => params.onStep?.(step),
          onRemoved: params.onStep,
        });
      }
      return { status: "ok", phase: "readiness", durationMs: 1, logTail: [], steps: [] };
    });

    await rehearse({ protocol: 1, config: {} }, undefined, answer);

    expect(check).not.toHaveBeenCalled();
    // Nobody is left to record the cleanup, and the copy is still removed.
    await expect(fs.access(copy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(process.exitCode).toBe(2);
  },
);

const timedOut = { exitCode: null, termination: "timeout" } as const;
const stalledGateway = { ...rehearsalStep, ...timedOut, name: "candidate-gateway-startup" };

it.each([
  ["candidate-checks-timeout", "doctor", [], "candidate-checks-timeout"],
  ["candidate-snapshot-failed", "snapshot", [], "candidate-snapshot-failed"],
  // The canary reports a Gateway that stalls before it is ready as a failed runtime check.
  [
    "runtime-verification-failed",
    "startup",
    [stalledGateway],
    "candidate-gateway-startup ran out of time",
  ],
] as const)("does not refuse an update over %s", async (reason, phase, steps, cause) => {
  canary.mockResolvedValue({
    status: "error",
    reason,
    phase,
    durationMs: 1,
    logTail: [],
    steps: [rehearsalStep, ...steps],
  } satisfies CanaryResult);

  await rehearse({ protocol: 1, config: {} });

  // No verdict: the installed updater's own checks decide.
  expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({
    protocol: 1,
    error: "rehearsal-execution-failed",
  });
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining(`inconclusive (${cause})`),
  );
  expect(process.exitCode).toBe(2);
});

it.each([
  ["a Doctor that failed and then hung on exit", "doctor-failed", "doctor", []],
  ["a Gateway that crashed after a slow Doctor exit", "runtime-verification-failed", "startup", []],
  [
    "a Doctor failure whose cleanup ran out of time",
    "doctor-failed",
    "doctor",
    [{ ...rehearsalStep, ...timedOut, name: "candidate-state-cleanup" }],
  ],
] as const)("keeps the refusal of %s", async (_name, reason, phase, later) => {
  const result = {
    status: "error",
    reason,
    phase,
    durationMs: 1,
    logTail: [],
    steps: [{ ...rehearsalStep, ...timedOut }, ...later],
  } satisfies CanaryResult;
  canary.mockResolvedValue(result);

  await rehearse({ protocol: 1, config: {} });

  expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({ protocol: 1, result });
  expect(process.exitCode).toBe(3);
});

it("reports the processes its own commands start, so the updater can stop them", async () => {
  let pid: number | undefined;
  canary.mockImplementation(async () => {
    // The state copy and inventory run as commands like this one, not as canary checks.
    const command = await runUtf8CommandWithTimeout([process.execPath, "-e", ""], {
      timeoutMs: 30_000,
    });
    pid = command.pid;
    return { status: "ok", phase: "readiness", durationMs: 1, logTail: [], steps: [] };
  });

  const receipts = await rehearse({ protocol: 1, config: {} });

  expect(pid).toBeTypeOf("number");
  expect(receipts).toEqual([
    { type: "process", pid },
    { type: "process-closed", pid },
  ]);
  expect(process.exitCode).toBe(0);
});

it("ends the rehearsal instead of waiting on a receipt too large to deliver", async () => {
  canary.mockImplementation(async (params: UpdateCandidateCanaryParams) => {
    // The updater's line reader drops a line this long, so no answer could ever arrive.
    await params.onStep?.({ ...rehearsalStep, stdoutTail: "x".repeat(70_000) });
    return { status: "ok", phase: "readiness", durationMs: 1, logTail: [], steps: [] };
  });

  expect(await rehearse({ protocol: 1, config: {} })).toEqual([]);
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("too large to deliver"),
  );
  expect(process.exitCode).toBe(2);
});

it("proves it is alive while a check runs longer than the updater's patience", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let finish: (result: CanaryResult) => void = () => {};
  const started = new Promise<void>((resolve) => {
    canary.mockImplementation(
      () =>
        new Promise<CanaryResult>((settle) => {
          finish = settle;
          resolve();
        }),
    );
  });
  const receipts: unknown[] = [];
  const running = rehearse({ protocol: 1, config: {} }).then((all) => receipts.push(...all));
  await started;
  vi.advanceTimersByTime(45_000);
  finish({ status: "ok", phase: "readiness", durationMs: 1, logTail: [], steps: [] });
  await running;

  expect(receipts).toEqual(Array.from({ length: 3 }, () => ({ type: "heartbeat" })));
});
