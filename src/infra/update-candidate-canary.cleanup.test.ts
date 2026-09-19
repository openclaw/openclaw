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
        const name = duringDoctor ? "Checking data migrations" : "Checking Gateway startup";
        const cleanup = result.steps.find((step) => step.name === `${name} cleanup`);
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
        expect.objectContaining({ name: "Checking Gateway startup", exitCode: 0 }),
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
