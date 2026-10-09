import { ChildProcess, spawnSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";

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

function createChild() {
  const child = new ChildProcess();
  let exitCode: number | null = null;
  Object.defineProperties(child, {
    pid: { value: 12345 },
    exitCode: { get: () => exitCode },
    stdout: { value: null, writable: true },
    stderr: { value: null, writable: true },
  });
  return {
    child,
    exit: () => {
      exitCode = 0;
      child.emit("exit", 0, null);
    },
  };
}

describe("managed child termination facts", () => {
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
    "verifies Darwin EPERM at $phase against all group members ($rows, failed=$failed, reaped=$reaped)",
    async ({ phase, rows, failed, reaped, accepted }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { child, exit } = createChild();
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
        return {
          pid: 12346,
          output: [],
          stdout: rows,
          stderr: "",
          status: failed ? 1 : 0,
          signal: null,
        };
      });
      const command = runManagedCommand({
        bin: "fixture",
        platform: "darwin",
        shell: false,
        stdio: "ignore",
        env: { TMPDIR: process.cwd() },
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

  it.each(["SIGTERM", "SIGKILL"])(
    "retains POSIX %s failures through cleanup",
    async (failedSignal) => {
      const { child } = createChild();
      const groupError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
      const childError = Object.assign(new Error("child signal denied"), { code: "EACCES" });
      const kill = vi.spyOn(child, "kill").mockImplementation((signal) => {
        if (signal === failedSignal) {
          throw childError;
        }
        return true;
      });
      const signalProcess = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === failedSignal) {
          throw groupError;
        }
        return true;
      });
      spawn.mockReturnValue(child);
      const abort = new AbortController();
      await expect(
        runManagedCommand({
          bin: "fixture",
          platform: "linux",
          shell: false,
          stdio: "ignore",
          env: { TMPDIR: process.cwd() },
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
    },
  );

  it.each(["exit", "missing PID", "alive"] as const)(
    "retains an unowned Windows tree after taskkill status 255 (%s)",
    async (state) => {
      const { child, exit } = createChild();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const kill = vi.spyOn(child, "kill").mockReturnValue(true);
      vi.spyOn(process, "kill").mockImplementation(() => {
        if (state === "missing PID") {
          throw Object.assign(new Error("process is gone"), { code: "ESRCH" });
        }
        return true;
      });
      spawn.mockReturnValue(child);
      const abort = new AbortController();
      const outputClosed = Promise.all([once(child.stdout, "close"), once(child.stderr, "close")]);
      const runTaskkill = vi.fn(() => {
        if (state === "exit") {
          exit();
        }
        return {
          status: 255,
          stdout: Buffer.from("taskkill attempted the owned tree"),
          stderr: Buffer.from("taskkill could not find the task"),
        };
      });
      try {
        const completed = runManagedCommand({
          bin: "fixture",
          platform: "win32",
          shell: false,
          // IPC callers bypass Job admission and exercise the unowned-tree contract.
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          // The synthetic child has no filesystem resources to retain on failure.
          env: { TMPDIR: process.cwd() },
          runTaskkill,
          signal: abort.signal,
          onReady: () => abort.abort(),
        });
        // Output may close after the synchronous termination attempt returns.
        if (state !== "alive") {
          setImmediate(() => {
            if (state === "missing PID") {
              exit();
            }
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.emit("close", 0, null);
          });
          await expect(completed).rejects.toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "indeterminate",
          });
          expect(runTaskkill).toHaveBeenCalledOnce();
          expect(kill).not.toHaveBeenCalled();
        } else {
          await expect(completed).rejects.toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "indeterminate",
            cause: {
              message: expect.stringContaining('"status":255'),
              taskkill: expect.arrayContaining([
                expect.objectContaining({
                  status: 255,
                  stdout: "taskkill attempted the owned tree",
                  stderr: "taskkill could not find the task",
                }),
              ]),
            },
          });
        }
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
        await outputClosed;
      }
    },
  );
});
