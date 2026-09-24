import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  completeCanaryCommand,
  createCanarySnapshotResult,
  FakeChild,
  stubHealthyGateway,
} from "./update-candidate-canary.test-support.js";
import { cleanupUpdateTemporaryDirectory } from "./update-maintenance.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep, updateRunWarningMessages } from "./update-run-step.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  snapshot: vi.fn(),
  signal: vi.fn(),
  port: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandBuffered: mocks.snapshot,
}));
vi.mock("../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/kill-tree.js")>()),
  signalProcessTree: mocks.signal,
}));
vi.mock("./ports-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ports-probe.js")>()),
  tryListenOnPort: mocks.port,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let nextPid = 41_000;
const children = new Map<number, FakeChild>();

function canaryStateOptions(timeoutMs: number) {
  return { root, stateDir: root, config: {}, env: {}, timeoutMs };
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = path.join(await fs.realpath(tempDirs.make("canary-cleanup-")), "candidate");
  await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
  mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
    createCanarySnapshotResult(options.input),
  );
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = new FakeChild(nextPid++);
    children.set(child.pid, child);
    if (args.includes("--update-canary")) {
      return child;
    }
    completeCanaryCommand(child, args, () => ({
      pluginInventory: undefined,
      pluginErrors: false,
      runtimeContract: { state: 2, agent: 3 },
      runtimeError: false,
      lintReport: { ok: true, checksRun: 1, findings: [], warnings: [] },
    }));
    return child;
  });
  mocks.signal.mockImplementation(
    (pid: number, _signal: string, options: { onComplete?: () => void }) => {
      children.get(pid)?.emit("close", 0);
      options.onComplete?.();
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const child of children.values()) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  children.clear();
});

describe("canary teardown evidence", () => {
  beforeEach(() => {
    mocks.port.mockResolvedValue(43_123);
    stubHealthyGateway();
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
        const pending = cleanupUpdateTemporaryDirectory({
          root,
          directory: path.join(root, "unverified-copy"),
          name: "candidate-state-cleanup",
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
        removal.mockRestore();
        monotonicClock.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["completed", "deadline"] as const)(
    "records the disposable-copy wait after a passed canary (%s)",
    async (outcome) => {
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      const removalStarted = createDeferredCore<string>();
      const removal = createDeferredCore();
      const remove = fs.rm.bind(fs);
      const heldRemoval = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
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
      const onStep = vi.fn();
      const pending = validateUpdateCandidateCanary({
        ...canaryStateOptions(3_000),
        onProgress,
        onStep,
      });
      let retained: string | undefined;
      try {
        retained = await removalStarted.promise;
        expect(onStep).toHaveBeenCalledWith(
          expect.objectContaining({ name: "candidate-gateway-startup", exitCode: 0 }),
        );
        expect(onProgress).toHaveBeenCalledWith(
          expect.objectContaining({
            step: "candidate-state-cleanup",
            status: "in_progress",
            startedAtMs: Date.now(),
            detail: expect.stringContaining("budget=300000ms"),
          }),
        );
        expect(onProgress.mock.calls.at(-1)?.[0].detail).toContain(retained);
        if (outcome === "completed") {
          removal.resolve();
        } else {
          await vi.advanceTimersByTimeAsync(300_000);
        }
        const result = await pending;
        expect(result.status).toBe("ok");
        if (outcome === "completed") {
          expect(onProgress).toHaveBeenCalledWith(
            expect.objectContaining({ step: "candidate-state-cleanup", status: "completed" }),
          );
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
        heldRemoval.mockRestore();
        vi.useRealTimers();
        if (retained) {
          await remove(retained, { recursive: true, force: true });
        }
      }
    },
  );

  it.each([
    "passed",
    "failed",
    "pipes",
    "natural",
    "unconfirmed",
    "late",
    "missing",
    "malformed",
  ] as const)(
    "distinguishes a completed lint report (%s) from checks still running at the deadline",
    async (report) => {
      let now = 2_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const spawnNormally = mocks.spawn.getMockImplementation()!;
      const signalNormally = mocks.signal.getMockImplementation()!;
      const lintFindings = Array.from({ length: 5 }, (_, index) => ({
        checkId: `core/config-${index}`,
        message: `Invalid configuration ${index}.`,
      }));
      let lintChild: FakeChild | undefined;
      mocks.spawn.mockImplementation((command, args: string[], options) => {
        if (!args.includes("--lint")) {
          return spawnNormally(command, args, options);
        }
        const child = new FakeChild(nextPid++);
        lintChild = child;
        children.set(child.pid, child);
        queueMicrotask(() => {
          child.stderr.write("└  Doctor complete.\n");
          child.stdout.write(
            report === "missing" || report === "late"
              ? ""
              : JSON.stringify(
                  report === "malformed"
                    ? { ok: true }
                    : {
                        ok: report !== "failed",
                        checksRun: 1,
                        findings: report === "failed" ? lintFindings : [],
                      },
                ),
          );
          if (report === "pipes") {
            child.emit("exit", 0, null);
          }
        });
        now += 899;
        return child;
      });
      mocks.signal.mockImplementation((pid, signal, options) => {
        if (lintChild && pid === lintChild.pid) {
          if (report === "late") {
            lintChild.stdout.write(JSON.stringify({ ok: true, checksRun: 1, findings: [] }));
          }
          if (report === "unconfirmed") {
            now += 101;
            options.onComplete?.();
            return;
          }
          lintChild.emit(
            "exit",
            report === "natural" ? 0 : null,
            report === "natural" ? null : "SIGTERM",
          );
        }
        signalNormally(pid, signal, options);
      });
      try {
        const result = await validateUpdateCandidateCanary(canaryStateOptions(1_000));
        const step = result.steps.find((entry) => entry.name === "candidate-doctor-lint")!;
        expect(step.termination).toBe("timeout");
        const completed = ["passed", "failed", "pipes", "natural", "unconfirmed"].includes(report);
        const rendered = renderUpdateRunReport(
          updateRunReportInputFromResult({ ...result, mode: "git", root }),
        );
        if (completed) {
          const message = `Update lint exit phase timed out after 0ms (899ms total); checks completed; ${report === "pipes" ? "output pipes stayed open" : "process did not exit"}. Continuing with recorded check results.`;
          expect(step.warnings).toEqual([message]);
          expect(rendered.markdown).toContain(message);
          if (report === "failed") {
            expect(result).toMatchObject({ status: "error", phase: "lint" });
            expect(step.failureFacts?.map((fact) => fact.message)).toEqual(
              lintFindings.map((finding) => finding.message),
            );
          } else {
            expect(result).toMatchObject({ status: "ok", phase: "readiness" });
            expect(step.failureFacts).toBeUndefined();
          }
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
              message: "Update lint checks phase timed out (899ms)",
            },
          ]);
          expect(rendered.markdown).toContain("checks phase");
          expect(JSON.stringify(result)).not.toContain("exit phase");
        }
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["close", "term-callback", "kill-callback", "error", "cancelled"] as const)(
    "reports incomplete %s evidence without changing validation outcomes",
    async (missing) => {
      let now = 2_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const spawnNormally = mocks.spawn.getMockImplementation()!;
      const signalNormally = mocks.signal.getMockImplementation()!;
      const heldCallbacks: Array<() => void> = [];
      const controller = new AbortController();
      const duringDoctor = missing === "error" || missing === "cancelled";
      let controlled: FakeChild | undefined;
      mocks.spawn.mockImplementation(
        (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          if (!(duringDoctor ? args.includes("--fix") : args.includes("--update-canary"))) {
            return spawnNormally(command, args, options);
          }
          controlled = new FakeChild(nextPid++);
          children.set(controlled.pid, controlled);
          if (missing === "error") {
            const child = controlled;
            queueMicrotask(() =>
              child.emit("error", new Error("synthetic validation process error")),
            );
          }
          if (missing === "cancelled") {
            controller.abort();
          }
          return controlled;
        },
      );
      mocks.signal.mockImplementation(
        (pid: number, signal: string, options: { onComplete?: () => void }) => {
          if (pid !== controlled?.pid) {
            signalNormally(pid, signal, options);
            return;
          }
          if (signal === "SIGTERM") {
            now += 3_000;
            if (missing === "close") {
              controlled.emit("exit", 0);
            }
          }
          if (missing === "term-callback" || missing === "kill-callback") {
            controlled.emit("close", 0);
          }
          const hold =
            (missing === "term-callback" && signal === "SIGTERM") ||
            (missing === "kill-callback" && signal === "SIGKILL");
          if (hold && options.onComplete) {
            heldCallbacks.push(options.onComplete);
          } else {
            options.onComplete?.();
          }
        },
      );
      const onStep = vi.fn();
      try {
        const result = await validateUpdateCandidateCanary({
          ...canaryStateOptions(3_000),
          signal: controller.signal,
          onStep,
        });
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
            .filter(([pid]) => pid === controlled?.pid)
            .map(([, signal]) => signal),
        ).toEqual(["SIGTERM", "SIGKILL"]);
        if (duringDoctor) {
          expect(result).toMatchObject({
            status: "error",
            phase: "doctor",
            reason: "doctor-failed",
          });
          if (missing === "error") {
            expect(result.steps.at(-1)?.failureFacts?.[0]?.message).toContain(
              "synthetic validation process error",
            );
          } else {
            expect(result.steps.at(-1)?.exitCode).toBe(1);
          }
          expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("--update-canary"))).toBe(
            false,
          );
        } else {
          expect(result).toMatchObject({ status: "ok", phase: "readiness" });
          expect(result.steps).toContainEqual(expect.objectContaining({ name, exitCode: 0 }));
          expect(
            result.steps.find((step) => step.exitCode !== 0 && !step.advisory),
          ).toBeUndefined();
        }
      } finally {
        for (const callback of heldCallbacks) {
          callback();
        }
        controlled?.emit("close", 0);
        controlled?.stdout.destroy();
        controlled?.stderr.destroy();
        clock.mockRestore();
      }
    },
  );

  it("joins close and both signal callbacks after recording readiness", async () => {
    const term = createDeferredCore<() => void>();
    const kill = createDeferredCore<() => void>();
    const spawnNormally = mocks.spawn.getMockImplementation()!;
    const signalNormally = mocks.signal.getMockImplementation()!;
    let gateway: FakeChild | undefined;
    mocks.spawn.mockImplementation(
      (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        if (!args.includes("--update-canary")) {
          return spawnNormally(command, args, options);
        }
        gateway = new FakeChild(nextPid++);
        children.set(gateway.pid, gateway);
        return gateway;
      },
    );
    mocks.signal.mockImplementation(
      (pid: number, signal: string, options: { onComplete: () => void }) => {
        if (pid !== gateway?.pid) {
          signalNormally(pid, signal, options);
          return;
        }
        (signal === "SIGTERM" ? term : kill).resolve(options.onComplete);
      },
    );
    const onStep = vi.fn();
    const result = validateUpdateCandidateCanary({ ...canaryStateOptions(3_000), onStep });
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let termComplete: (() => void) | undefined;
    let killComplete: (() => void) | undefined;
    try {
      termComplete = await term.promise;
      expect(onStep).toHaveBeenCalledWith(
        expect.objectContaining({ name: "candidate-gateway-startup", exitCode: 0 }),
      );
      gateway!.emit("close", 0);
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
      gateway?.emit("close", 0);
      gateway?.stdout.destroy();
      gateway?.stderr.destroy();
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
      const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
      expect(result).toMatchObject({ status: "error", phase: "doctor", reason: "doctor-failed" });
      expect(result.steps.at(-1)?.failureFacts?.[0]?.message).toContain("synthetic spawn failure");
      expect(mocks.signal).not.toHaveBeenCalled();
      expect(result.steps.some((step) => step.advisory)).toBe(false);
    } finally {
      child.emit("close", null);
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
});
