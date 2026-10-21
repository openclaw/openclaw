import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSyntheticChild,
  psResult,
  runFixtureCommand,
} from "./managed-child-process.test-support.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
  spawnSync: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each([
  { phase: "inspection", rows: "12345 Z\n12345 ZN\n", accepted: true },
  { phase: "signal", rows: "12345 Z\n", accepted: true },
  { phase: "inspection", rows: "", reaped: true, accepted: true },
  { phase: "signal", rows: "", failed: true, reaped: true, accepted: true },
  { phase: "inspection", rows: "12345 Z\n12345 S\n", accepted: false },
  { phase: "inspection", rows: "", accepted: false },
  { phase: "inspection", rows: "23456 Z\n", accepted: false },
  { phase: "inspection", rows: "12345 Z\n", failed: true, accepted: false },
])(
  "Darwin EPERM: $phase / $rows / $failed / $reaped",
  async ({ phase, rows, failed, reaped, accepted }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { child, exit } = createSyntheticChild();
    spawn.mockReturnValue(child);
    vi.spyOn(child, "kill").mockReturnValue(false);
    let signaled = false;
    let inspected = false;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal !== 0) {
        signaled = true;
        if (!accepted) {
          vi.setSystemTime(Date.now() + 100);
        }
      }
      if (signal === 0 && signaled && !inspected) {
        vi.setSystemTime(Date.now() + 100);
      }
      if (phase === "signal" && !signaled) {
        return true;
      }
      throw Object.assign(new Error("group signal denied"), {
        code: reaped && inspected ? "ESRCH" : "EPERM",
      });
    });
    vi.mocked(spawnSync).mockImplementation(() => {
      inspected = true;
      return psResult(rows, { status: failed ? 1 : 0 });
    });
    const command = runFixtureCommand({
      platform: "darwin",
      requireProcessTreeExit: true,
      cleanupDrainTimeoutMs: 50,
      onReady: exit,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    if (accepted) {
      expect(await command).toEqual({ value: 0 });
    } else {
      expect(await command).toMatchObject({ error: { code: "EPROCESSGROUP_CLEANUP_FAILED" } });
    }
  },
);

it.each(["SIGTERM", "SIGKILL"])("retains POSIX %s failures", async (failedSignal) => {
  const { child } = createSyntheticChild();
  const groupError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
  const childError = Object.assign(new Error("child signal denied"), { code: "EACCES" });
  const failWith = (error: Error, signal: Parameters<typeof process.kill>[1]): true => {
    if (signal === failedSignal) {
      throw error;
    }
    return true;
  };
  const kill = vi.spyOn(child, "kill").mockImplementation((signal) => failWith(childError, signal));
  const signalProcess = vi
    .spyOn(process, "kill")
    .mockImplementation((_pid, signal) => failWith(groupError, signal));
  spawn.mockReturnValue(child);
  const abort = new AbortController();
  await expect(
    runFixtureCommand({
      platform: "linux",
      signal: abort.signal,
      abortKillGraceMs: 0,
      cleanupDrainTimeoutMs: 0,
      onReady: () => abort.abort(),
    }),
  ).rejects.toMatchObject({
    code: "EPROCESSGROUP_CLEANUP_FAILED",
    cause: { errors: [groupError, childError] },
  });
  expect(kill).toHaveBeenCalledWith(failedSignal);
  expect(signalProcess).toHaveBeenCalledWith(-12345, "SIGKILL");
});

it.each(["exit", "missing PID", "alive"] as const)("unowned Windows tree: %s", async (state) => {
  const { child, exit, waitForOutputClose, destroyOutput } = createSyntheticChild("both");
  const kill = vi.spyOn(child, "kill").mockReturnValue(true);
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (state === "missing PID") {
      throw Object.assign(new Error("process is gone"), { code: "ESRCH" });
    }
    return true;
  });
  spawn.mockReturnValue(child);
  const abort = new AbortController();
  const outputClosed = waitForOutputClose();
  const taskkill = { status: 255, stdout: "tree attempted", stderr: "task not found" };
  const runTaskkill = vi.fn(() => {
    if (state === "exit") {
      exit();
    }
    return {
      ...taskkill,
      stdout: Buffer.from(taskkill.stdout),
      stderr: Buffer.from(taskkill.stderr),
    };
  });
  try {
    const completed = runFixtureCommand({
      platform: "win32",
      // IPC bypasses Job admission.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      runTaskkill,
      signal: abort.signal,
      onReady: () => abort.abort(),
    });
    if (state !== "alive") {
      setImmediate(() => {
        if (state === "missing PID") {
          exit();
        }
        destroyOutput();
        child.emit("close", 0, null);
      });
    }
    await expect(completed).rejects.toMatchObject({
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState: "indeterminate",
      ...(state === "alive"
        ? {
            cause: {
              message: expect.stringContaining('"status":255'),
              taskkill: expect.arrayContaining([expect.objectContaining(taskkill)]),
            },
          }
        : {}),
    });
    if (state !== "alive") {
      expect(runTaskkill).toHaveBeenCalledOnce();
      expect(kill).not.toHaveBeenCalled();
    }
  } finally {
    destroyOutput();
    await outputClosed;
  }
});
