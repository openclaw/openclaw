import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  createCanarySnapshotResult,
  type FakeChild,
  stubHealthyGateway,
  canaryOutcomeStep,
} from "./update-candidate-canary.test-support.js";
import { createCanaryHarness } from "./update-candidate-harness.test-support.js";
import { cleanupUpdateTemporaryDirectory } from "./update-maintenance.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep, updateRunWarningMessages } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  snapshot: vi.fn(),
  signal: vi.fn(),
  port: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./update-candidate-canary-mocks.test-support.js")).mockCanaryChildProcesses(
    await importOriginal<typeof import("node:child_process")>(),
    mocks.spawn,
  ),
);
vi.mock("../process/exec.js", async (importOriginal) => {
  const { mockCanarySnapshotCommands } =
    await import("./update-candidate-canary-mocks.test-support.js");
  return mockCanarySnapshotCommands(
    await importOriginal<typeof import("../process/exec.js")>(),
    mocks.snapshot,
  );
});
vi.mock("../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/kill-tree.js")>()),
  signalProcessTree: mocks.signal,
}));
vi.mock("./ports-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ports-probe.js")>()),
  tryListenOnPort: mocks.port,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const harness = createCanaryHarness(mocks, {
  isGateway: (args) => args.includes("--update-canary"),
});
const { children } = harness;
let root: string;

type CanaryOptions = Parameters<typeof validateUpdateCandidateCanary>[0];
function canary(options: Partial<CanaryOptions> = {}) {
  return validateUpdateCandidateCanary({ ...harness.options(3_000), ...options });
}

function makeChild() {
  return harness.child(true);
}

function interceptSpawn(
  flag: string,
  configure: (child: FakeChild, options: { env: NodeJS.ProcessEnv }) => void = () => {},
) {
  const spawnNormally = mocks.spawn.getMockImplementation()!;
  const controlled: { child?: FakeChild } = {};
  mocks.spawn.mockImplementation((command, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    if (!args.includes(flag)) {
      return spawnNormally(command, args, options);
    }
    const child = (controlled.child = makeChild());
    configure(child, options);
    return child;
  });
  return controlled;
}

function interceptSignal(
  controlled: { child?: FakeChild },
  callback: (child: FakeChild, signal: string, options: { onComplete?: () => void }) => void,
) {
  const signalNormally = mocks.signal.getMockImplementation()!;
  mocks.signal.mockImplementation((pid, signal, options) => {
    if (pid === controlled.child?.pid) {
      callback(controlled.child, signal, options);
    } else {
      signalNormally(pid, signal, options);
    }
  });
}

function markdown(result: Awaited<ReturnType<typeof canary>>) {
  return renderUpdateRunReport(updateRunReportInputFromResult({ ...result, mode: "git", root }))
    .markdown;
}

function expectRecorded(mock: ReturnType<typeof vi.fn>, expected: unknown) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(expected));
}

function cleanupDirectory(
  options: Omit<Parameters<typeof cleanupUpdateTemporaryDirectory>[0], "root" | "name">,
) {
  return cleanupUpdateTemporaryDirectory({ root, name: "candidate-state-cleanup", ...options });
}

beforeEach(async () => {
  root = await harness.reset(tempDirs.make("canary-cleanup-"));
  mocks.port.mockResolvedValue(43_123);
  stubHealthyGateway();
});

afterEach(() => {
  harness.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["initial-progress", "candidate-gateway-startup"])(
  "propagates a %s receipt refusal once, cleaning up only admitted work",
  async (stepName) => {
    let copiedStateDir: string | undefined;
    mocks.snapshot.mockImplementation(async (_command, options: { input: string }) => {
      const request: unknown = JSON.parse(options.input);
      if (isRecord(request) && request.mode === "snapshot") {
        if (typeof request.targetStateDir !== "string") {
          throw new Error("Snapshot fixture requires its owned target directory");
        }
        copiedStateDir = request.targetStateDir;
      }
      return createCanarySnapshotResult(options.input);
    });
    const refusal = new Error("progress receipt was refused");
    let refused = false;
    const onStep = vi.fn(async (step: UpdateStepResult) => {
      if (step.name === stepName && !refused) {
        refused = true;
        throw refusal;
      }
    });
    await expect(
      canary({
        onStep,
        onProgress:
          stepName === "initial-progress" ? vi.fn().mockRejectedValue(refusal) : undefined,
      }),
    ).rejects.toBe(refusal);
    if (stepName === "initial-progress") {
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(onStep).not.toHaveBeenCalled();
      return;
    }
    expect(onStep.mock.calls.filter(([step]) => step.name === stepName)).toEqual([
      [expect.objectContaining({ exitCode: 0 })],
    ]);
    for (const child of children.values()) {
      expect(child.exitCode).toBe(0);
    }
    if (!copiedStateDir) {
      throw new Error("Candidate did not create its private state copy");
    }
    await expect(fs.access(copiedStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["candidate-doctor", "candidate-gateway-startup"])(
  "awaits the %s start receipt before launching its process",
  async (name) => {
    const entered = createDeferredCore();
    const receipt = createDeferredCore();
    const refusal = new Error("check start receipt was refused");
    const onStep = vi.fn();
    const pending = canary({
      onStep,
      onProgress: (step) => {
        if (step.step === name && step.status === "in_progress") {
          entered.resolve();
          return receipt.promise;
        }
        return undefined;
      },
    });
    try {
      await Promise.race([entered.promise, pending]);
      expect(mocks.spawn).toHaveBeenCalledTimes(name === "candidate-doctor" ? 0 : 5);
      receipt.reject(refusal);
      await expect(pending).rejects.toBe(refusal);
      expect(onStep.mock.calls.some(([step]) => step.name === name)).toBe(false);
    } finally {
      receipt.resolve();
      await pending.catch(() => undefined);
    }
  },
);

it("retains integrity progress and timeout cause after a zero-exit teardown", async () => {
  let now = 2_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const waiting = createDeferredCore();
  const progress =
    "SQLite integrity check still running: agent database (400 MiB, 10s elapsed, phase=checking).";
  mocks.spawn.mockImplementationOnce(() => {
    const child = makeChild();
    queueMicrotask(() => {
      child.stderr.write(`[state/sqlite] ${progress}\n`);
      waiting.resolve();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    now += 899;
    return child;
  });
  const pending = canary({ timeoutMs: 1_000 });
  await waiting.promise;
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  const cause = "candidate-migration-rehearsal: doctor exceeded budget after 1 s";
  expect(result).toMatchObject({
    status: "error",
    phase: "doctor",
    reason: "candidate-checks-timeout",
  });
  expect(result.logTail.join("\n")).toContain(`${cause} ([state/sqlite] ${progress})`);
  const failed = canaryOutcomeStep(result.steps)!;
  expect(failed).toMatchObject({ exitCode: null, termination: "timeout" });
  expect(failed.failureFacts).toEqual([
    expect.objectContaining({
      check: "doctor",
      code: "candidate-checks-timeout",
      message: expect.stringContaining(cause),
    }),
  ]);
  const detail = updateRunStepsFromResultStep(failed).at(-1)?.detail;
  expect(failed.stderrTail).toContain("phase=checking");
  expect(detail).toContain(cause);
  const report = markdown(result);
  expect(report).toContain(cause);
  expect(report).toContain("phase=checking");
  expect(report).not.toContain("usable inference route");
});

it.each(["before-deadline", "after-deadline"] as const)(
  "retains uncertain cleanup progress after custody succeeds (%s)",
  async (timing) => {
    const directory = path.join(root, "owned-cleanup-copy");
    await fs.mkdir(directory);
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const entered = createDeferredCore();
    const receipt = createDeferredCore();
    const uncertain = new CommandProcessCleanupError();
    const remove = vi.spyOn(fs, "rm");
    const onWarning = vi.fn();
    const pending = cleanupDirectory({
      directory,
      canRemove: async () => true,
      onProgress: (step) => {
        if (step.detail?.includes("waiting for filesystem removal")) {
          entered.resolve();
          return receipt.promise;
        }
        return undefined;
      },
      onWarning,
    });
    const rejected = expect(pending).rejects.toBe(uncertain);
    try {
      await entered.promise;
      if (timing === "after-deadline") {
        await vi.advanceTimersByTimeAsync(300_000);
      }
      expect(remove).not.toHaveBeenCalled();
      expect(onWarning).not.toHaveBeenCalled();
      receipt.reject(uncertain);
      await rejected;
      expect(remove).not.toHaveBeenCalled();
      expect(onWarning).not.toHaveBeenCalled();
      await fs.access(directory);
    } finally {
      receipt.resolve();
      await pending.catch(() => undefined);
      await rejected.catch(() => undefined);
    }
  },
);

it("preserves uncertain startup when recording its stop warning also fails", async () => {
  const response = createDeferredCore<Response>();
  const fetching = createDeferredCore();
  const uncertain = new CommandProcessCleanupError();
  const cleanupFailure = new Error("cleanup warning ledger unavailable");
  let retained: string | undefined;
  const gateway = interceptSpawn("--update-canary", (_child, options) => {
    retained = options.env.OPENCLAW_STATE_DIR;
  });
  interceptSignal(gateway, (child, _signal, options) => {
    child.emit("exit", 0);
    options.onComplete?.();
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, options: RequestInit) => {
      options.signal?.addEventListener("abort", () => response.reject(options.signal?.reason));
      fetching.resolve();
      return response.promise;
    }),
  );
  const onStep = vi.fn((step: { name: string }) => {
    if (step.name === "candidate-recovery") {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    }
    if (step.name === "candidate-gateway-startup-cleanup") {
      throw cleanupFailure;
    }
  });
  const pending = canary({
    timeoutMs: 1_000,
    onStep,
    onProgress: async (step) => {
      if (step.step === "warning:candidate-gateway-startup") {
        throw uncertain;
      }
    },
  });
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await fetching.promise;
    await vi.advanceTimersByTimeAsync(300);
    gateway.child!.stderr.write("openclaw-update-canary-progress: config.snapshot\n");
    await vi.advanceTimersByTimeAsync(2_600);
    const failure = await outcome;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ cause: cleanupFailure, errors: [uncertain, cleanupFailure] });
    expect(hasCommandProcessCleanupError(failure)).toBe(true);
    expect(onStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "candidate-gateway-startup-cleanup" }),
    );
    if (!retained) {
      throw new Error("Gateway did not capture its rehearsal state directory");
    }
    await fs.access(path.join(retained, "openclaw.json"));
  } finally {
    response.resolve(Response.json({ status: "started", ready: true }));
    gateway.child?.emit("close", 0);
    await outcome;
    vi.useRealTimers();
    if (retained) {
      await fs.rm(retained, { recursive: true, force: true });
    }
  }
});

it.each(["timer", "elapsed"] as const)(
  "does not start removal when custody resolves after the cleanup budget (%s)",
  async (expiry) => {
    vi.useFakeTimers();
    const monotonicClock = vi.spyOn(performance, "now").mockReturnValue(0);
    const custody = createDeferredCore<boolean>();
    const removal = vi.spyOn(fs, "rm");
    const onProgress = vi.fn();
    const onWarning = vi.fn();
    try {
      const pending = cleanupDirectory({
        directory: path.join(root, "unverified-copy"),
        canRemove: () => custody.promise,
        onProgress,
        onWarning,
      });
      expect(onProgress).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: "in_progress",
          detail: expect.stringContaining("waiting for directory custody verification"),
        }),
      );
      monotonicClock.mockReturnValue(300_000);
      if (expiry === "timer") {
        await vi.advanceTimersByTimeAsync(300_000);
      } else {
        custody.resolve(true);
      }
      await pending;
      expect(onWarning).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "",
          termination: "timeout",
          advisory: expect.objectContaining({
            message: expect.stringContaining("ownership could not be verified"),
          }),
        }),
      );
      custody.resolve(true);
      await Promise.resolve();
      expect(removal).not.toHaveBeenCalled();
      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress.mock.calls[0]?.[0].detail).not.toContain("filesystem removal");
    } finally {
      custody.resolve(false);
    }
  },
);

it.each(["completed", "deadline"] as const)(
  "records the disposable-copy wait after a passed canary (%s)",
  async (outcome) => {
    const removalStarted = createDeferredCore<string>();
    const removal = createDeferredCore();
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        typeof target === "string" &&
        path.basename(target).startsWith("openclaw-update-canary-")
      ) {
        removalStarted.resolve(target);
        return removal.promise;
      }
      return remove(target, options);
    });
    const onProgress = vi.fn();
    const onStep = vi.fn((step: { name: string }) => {
      if (step.name === "candidate-gateway-startup") {
        // Snapshot subprocess settlement must finish before virtualizing the cleanup clock.
        vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      }
    });
    const pending = canary({ onProgress, onStep });
    let retained: string | undefined;
    try {
      retained = await removalStarted.promise;
      expectRecorded(onStep, { name: "candidate-gateway-startup", exitCode: 0 });
      expectRecorded(onProgress, {
        step: "candidate-state-cleanup",
        status: "in_progress",
        startedAtMs: Date.now(),
        detail: expect.stringContaining("budget=300000ms"),
      });
      expect(onProgress.mock.calls.at(-1)?.[0].detail).toContain(retained);
      if (outcome === "completed") {
        removal.resolve();
      } else {
        await vi.advanceTimersByTimeAsync(300_000);
      }
      const result = await pending;
      expect(result.status).toBe("ok");
      if (outcome === "completed") {
        expectRecorded(onProgress, { step: "candidate-state-cleanup", status: "completed" });
        expect(result.steps.some((step) => step.advisory)).toBe(false);
      } else {
        const warning = result.steps.find((step) => step.name === "candidate-state-cleanup")!;
        expect(warning).toMatchObject({
          termination: "timeout",
          advisory: {
            kind: "recoverable-maintenance",
            message: expect.stringContaining("300000ms"),
          },
        });
        expect(warning.advisory?.message).toContain(retained);
        expect(warning.advisory?.message).toContain("after the updater exits");
        expect(onStep).toHaveBeenCalledWith(warning);
        const beforeLateRemoval = onProgress.mock.calls.length;
        removal.resolve();
        await Promise.resolve();
        expect(onProgress).toHaveBeenCalledTimes(beforeLateRemoval);
      }
    } finally {
      removal.resolve();
      await pending;
      vi.mocked(fs.rm).mockRestore();
      vi.useRealTimers();
      if (retained) {
        await remove(retained, { recursive: true, force: true });
      }
    }
  },
);

it.each(["pipes", "unconfirmed", "late", "malformed"] as const)(
  "distinguishes a completed lint report (%s) from checks still running at the deadline",
  async (report) => {
    let now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const lintReport = { ok: true, checksRun: 1, findings: [] };
    const lint = interceptSpawn("--lint", (child) => {
      queueMicrotask(() => {
        child.stderr.write("└  Doctor complete.\n");
        child.stdout.write(
          report === "late"
            ? ""
            : JSON.stringify(report === "malformed" ? { ok: true } : lintReport),
        );
        if (report === "pipes") {
          child.emit("exit", 0, null);
        }
      });
      now += 899;
    });
    const signalNormally = mocks.signal.getMockImplementation()!;
    interceptSignal(lint, (child, signal, options) => {
      if (report === "late") {
        child.stdout.write(JSON.stringify(lintReport));
      }
      if (report === "unconfirmed") {
        now += 101;
        options.onComplete?.();
        return;
      }
      child.emit("exit", null, "SIGTERM");
      signalNormally(child.pid, signal, options);
    });
    const result = await canary({ timeoutMs: 1_000 });
    const step = result.steps.find((entry) => entry.name === "candidate-doctor-lint")!;
    expect(step.termination).toBe("timeout");
    const completed = report === "pipes" || report === "unconfirmed";
    const rendered = markdown(result);
    if (completed) {
      const message = `Update lint exit phase timed out after 0ms (899ms total); checks completed; ${report === "pipes" ? "output pipes stayed open" : "process did not exit"}. Continuing with recorded check results.`;
      expect(step.warnings).toEqual([message]);
      expect(rendered).toContain(message);
      expect(result).toMatchObject({ status: "ok", phase: "readiness" });
      expect(step.failureFacts).toBeUndefined();
    } else {
      expect(result).toMatchObject({
        status: "error",
        phase: "lint",
        reason: "candidate-checks-timeout",
      });
      expect(step.failureFacts).toEqual([
        {
          check: "lint",
          code: "candidate-checks-timeout",
          message:
            "candidate-migration-rehearsal: lint exceeded budget after 1 s (└  Doctor complete.)",
        },
      ]);
      expect(rendered).toContain("lint exceeded budget after 1 s");
      expect(JSON.stringify(result)).not.toContain("exit phase");
    }
  },
);

it.each(["close", "error", "cancelled"] as const)(
  "reports incomplete %s evidence without changing validation outcomes",
  async (missing) => {
    let now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const controller = new AbortController();
    const duringDoctor = missing === "error" || missing === "cancelled";
    const controlled = interceptSpawn(duringDoctor ? "--fix" : "--update-canary", (child) => {
      if (missing === "error") {
        queueMicrotask(() => child.emit("error", new Error("synthetic validation process error")));
      }
      if (missing === "cancelled") {
        controller.abort();
      }
    });
    interceptSignal(controlled, (child, signal, options) => {
      if (signal === "SIGTERM") {
        now += 3_000;
        if (missing === "close") {
          child.emit("exit", 0);
        }
      }
      options.onComplete?.();
    });
    const onStep = vi.fn();
    try {
      const result = await canary({ signal: controller.signal, onStep });
      const name = duringDoctor ? "candidate-doctor" : "candidate-gateway-startup";
      const cleanup = result.steps.find((step) => step.name === `${name}-cleanup`);
      expect(cleanup).toMatchObject({
        exitCode: null,
        advisory: {
          kind: "recoverable-maintenance",
          message: expect.stringContaining("process close and termination requests"),
        },
      });
      expect(onStep).toHaveBeenCalledWith(cleanup);
      expect(
        updateRunWarningMessages(result.steps.flatMap(updateRunStepsFromResultStep)),
      ).toContain(cleanup?.advisory?.message);
      expect(
        mocks.signal.mock.calls
          .filter(([pid]) => pid === controlled.child?.pid)
          .map(([, signal]) => signal),
      ).toEqual(["SIGTERM", "SIGKILL"]);
      if (duringDoctor) {
        expect(result).toMatchObject({
          status: "error",
          phase: "doctor",
          reason: "doctor-failed",
        });
        if (missing === "error") {
          expect(canaryOutcomeStep(result.steps)?.failureFacts?.[0]?.message).toContain(
            "synthetic validation process error",
          );
        } else {
          expect(canaryOutcomeStep(result.steps)?.exitCode).toBe(1);
        }
        expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("--update-canary"))).toBe(
          false,
        );
      } else {
        expect(result).toMatchObject({ status: "ok", phase: "readiness" });
        expect(result.steps).toContainEqual(expect.objectContaining({ name, exitCode: 0 }));
        expect(result.steps.find((step) => step.exitCode !== 0 && !step.advisory)).toBeUndefined();
      }
    } finally {
      controlled.child?.emit("close", 0);
    }
  },
);

it("joins close and both signal callbacks after recording readiness", async () => {
  const term = createDeferredCore<() => void>();
  const kill = createDeferredCore<() => void>();
  const gateway = interceptSpawn("--update-canary");
  interceptSignal(gateway, (_child, signal, options) => {
    if (options.onComplete) {
      (signal === "SIGTERM" ? term : kill).resolve(options.onComplete);
    }
  });
  const onStep = vi.fn();
  const result = canary({ onStep });
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void result.then(markSettled, markSettled);
  let termComplete: (() => void) | undefined;
  let killComplete: (() => void) | undefined;
  try {
    termComplete = await term.promise;
    expectRecorded(onStep, { name: "candidate-gateway-startup", exitCode: 0 });
    gateway.child!.emit("close", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    termComplete();
    killComplete = await kill.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    killComplete();
    const completed = await result;
    expect(completed.status).toBe("ok");
    expect(completed.steps.some((step) => step.advisory)).toBe(false);
  } finally {
    termComplete?.();
    killComplete?.();
    gateway.child?.emit("close", 0);
    await result.catch(() => undefined);
  }
});

it("keeps a spawn error without a process id as a validation failure", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  mocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("error", new Error("synthetic spawn failure")));
    return child;
  });
  try {
    const result = await canary();
    expect(result).toMatchObject({ status: "error", phase: "doctor", reason: "doctor-failed" });
    expect(canaryOutcomeStep(result.steps)?.failureFacts?.[0]?.message).toContain(
      "synthetic spawn failure",
    );
    expect(mocks.signal).not.toHaveBeenCalled();
    expect(result.steps.some((step) => step.advisory)).toBe(false);
  } finally {
    child.emit("close", null);
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
