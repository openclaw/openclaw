import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { runUpdateStep } from "./shared.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../../process/exec-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec-spawn.js")>()),
  spawnCommandWithInvocation: spawn,
}));
vi.mock("../../process/scoped-child-reaper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/scoped-child-reaper.js")>()),
  scheduleAdoptedChildZombieReapAfterExit: vi.fn(),
}));

class UpdateChild extends ChildProcess {
  override signalCode: NodeJS.Signals | null = null;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32").each(["timeout", "signal"] as const)(
  "settles a SIGTERM-ignoring update tree before reporting %s",
  async (termination) => {
    vi.useFakeTimers();
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(123);
    const root = Object.assign(new UpdateChild(), {
      pid: 4242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const alive = new Set([4242, 4243]);
    let detached = false;
    const completed = createDeferredCore<{
      exitCode: undefined;
      signal: NodeJS.Signals;
      failed: true;
      isTerminated: true;
    }>();
    const exit = (signal: NodeJS.Signals) => {
      alive.delete(4242);
      root.signalCode = signal;
      root.stdout.end();
      root.stderr.end();
      root.emit("exit", null, signal);
      completed.resolve({ exitCode: undefined, signal, failed: true, isTerminated: true });
    };
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      const targets = pid === -4242 && detached ? [...alive] : alive.has(pid) ? [pid] : [];
      if (targets.length === 0) {
        throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      }
      // Both fake processes ignore graceful signals; only a group kill reaches the worker.
      if (signal === "SIGKILL") {
        for (const target of targets) {
          alive.delete(target);
        }
        exit(signal);
      }
      return true;
    });
    spawn.mockImplementation((_argv, options: { detached: boolean; cancelSignal: AbortSignal }) => {
      detached = options.detached;
      // Model execa's direct-child cancellation separately from process-group signals.
      options.cancelSignal.addEventListener("abort", () => exit("SIGTERM"), { once: true });
      return {
        invocation: { usesWindowsExitCodeShim: false },
        child: Object.assign(completed.promise, {
          nodeChildProcess: root,
          pid: root.pid,
          stdout: root.stdout,
          stderr: root.stderr,
        }),
      };
    });
    const controller = new AbortController();
    const reported: number[][] = [];
    const step = runUpdateStep({
      name: "package-install",
      argv: ["fake-package-manager", "install"],
      timeoutMs: 1_000,
      signal: controller.signal,
      progress: {
        onStepComplete: () => {
          reported.push([...alive]);
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    if (termination === "signal") {
      controller.abort();
    }
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(step).resolves.toMatchObject({ termination });
    expect([...alive]).toEqual([]);
    expect(reported).toEqual([[]]);
  },
);
