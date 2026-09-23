import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnWindowsJobChild: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../../scripts/lib/managed-windows-job.mts", () => ({
  spawnWindowsJobChild: mocks.spawnWindowsJobChild,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("cancels admission while Windows platform code loads without spawning or retaining a claim", async () => {
  const root = dirs.make("managed-platform-cancel-");
  const owner = createVitestResourceOwner(root);
  mocks.spawn.mockClear();
  mocks.spawnWindowsJobChild.mockClear();
  const abort = new AbortController();
  const command = runManagedCommand({
    bin: "fixture",
    platform: "win32",
    signal: abort.signal,
    env: { TMPDIR: root },
  });
  abort.abort();
  await expect(command).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.spawnWindowsJobChild).not.toHaveBeenCalled();
  owner.assertReleased();
});

it("preserves requested command inputs across Windows platform loading", async () => {
  const root = dirs.make("managed-platform-inputs-");
  const child = new ChildProcess();
  Object.defineProperties(child, {
    pid: { value: 12345 },
    exitCode: { value: 0 },
    stdout: { value: null, writable: true },
    stderr: { value: null, writable: true },
  });
  let launched: { argument?: string; value?: string } | undefined;
  mocks.spawnWindowsJobChild.mockImplementation((_command, args, options) => {
    launched = { argument: args[0], value: options.env.VALUE };
    return {
      child,
      job: { inspect: () => [], beginStop() {}, stop() {}, close() {} },
    };
  });
  const args = ["original"];
  const env = { TMPDIR: root, VALUE: "original" };
  const command = runManagedCommand({
    bin: "fixture",
    args,
    env,
    platform: "win32",
    shell: false,
    onReady: () => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    },
  });
  args[0] = "mutated";
  env.VALUE = "mutated";
  await expect(command).resolves.toBe(0);
  expect(launched).toEqual({ argument: "original", value: "original" });
});

it("does not certify an unavailable POSIX group observation when its wait expires", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("group observation unavailable"), { code: "EIO" });
  });
  await expect(
    waitForManagedProcessGroupExit({ pid: 12345 }, 0, {
      platform: "darwin",
      errorPolicy: "indeterminate",
    }),
  ).resolves.toBe(false);
});

it.each(["returned false", "ESRCH"])(
  "does not promote POSIX leader disappearance (%s) after denied group signaling",
  (result) => {
    const child = {
      pid: 12345,
      kill: vi.fn(() => {
        if (result === "ESRCH") {
          throw Object.assign(new Error("leader is gone"), { code: "ESRCH" });
        }
        return false;
      }),
    };
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("group signal denied"), { code: "EPERM" });
    });
    expect(terminateManagedChild(child, "SIGTERM", { platform: "darwin" })).toEqual({
      processTreeState: "indeterminate",
    });
  },
);

it.each([false, true])(
  "retains signal failures after strict POSIX cleanup joins (leader signal fails: %s)",
  async (leaderSignalFails) => {
    const root = dirs.make("managed-joined-diagnostics-");
    const owner = createVitestResourceOwner(root);
    const child = new ChildProcess();
    Object.defineProperties(child, { pid: { value: 12345 }, exitCode: { value: 0 } });
    const groupError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
    const leaderError = Object.assign(new Error("leader signal denied"), { code: "EACCES" });
    mocks.spawn.mockReturnValue(child);
    const leaderSignal = vi.spyOn(child, "kill").mockImplementation(() => {
      if (leaderSignalFails) {
        throw leaderError;
      }
      return false;
    });
    let terminationAttempted = false;
    const groupSignal = vi.spyOn(process, "kill").mockImplementation((_pid, received) => {
      if (received === 0) {
        throw Object.assign(new Error("group observation"), {
          code: terminationAttempted ? "ESRCH" : "EPERM",
        });
      }
      terminationAttempted = true;
      throw groupError;
    });

    await expect(
      runManagedCommand({
        bin: "fixture",
        platform: "darwin",
        shell: false,
        stdio: "ignore",
        requireProcessTreeExit: true,
        env: { TMPDIR: root },
        onReady: () => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        },
      }),
    ).rejects.toMatchObject({
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processGroupId: 12345,
      processTreeState: "terminated",
      cause: expect.objectContaining({
        name: "AggregateError",
        errors: leaderSignalFails ? [groupError, leaderError] : [groupError],
      }),
    });
    expect(groupSignal.mock.calls).toEqual([
      [-12345, 0],
      [-12345, "SIGKILL"],
      [-12345, 0],
    ]);
    expect(leaderSignal).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    owner.assertReleased();
  },
);

it.each([
  ["win32", true, true],
  ["win32", false, true],
  ["darwin", true, true],
  ["darwin", false, true],
  ["win32", true, false],
] as const)(
  "finalizes normal leader exit on %s (termination succeeds: %s, handle closes: %s)",
  async (platform, terminates, closes) => {
    const root = dirs.make("managed-normal-exit-");
    const owner = createVitestResourceOwner(root);
    const child = new ChildProcess();
    Object.defineProperties(child, { pid: { value: 12345 }, exitCode: { value: 0 } });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const closed = Promise.all([once(child.stdout, "close"), once(child.stderr, "close")]);
    child.stdout.destroy();
    child.stderr.destroy();
    await closed;
    const descendantOutput = new PassThrough();
    const stopSurvivor = () => {
      if (!terminates) {
        throw Object.assign(new Error("survivor termination denied"), { code: "EPERM" });
      }
      descendantOutput.destroy();
    };
    let jobClosed = false;
    const job = {
      inspect: vi.fn(() => {
        if (jobClosed) {
          throw new Error("Job handle is closed");
        }
        return descendantOutput.destroyed ? [] : [23456];
      }),
      beginStop: vi.fn(),
      stop: vi.fn(stopSurvivor),
      close: vi.fn(() => {
        if (!closes) {
          throw new Error("CloseHandle failed");
        }
        jobClosed = true;
      }),
    };
    mocks.spawn.mockReturnValue(child);
    mocks.spawnWindowsJobChild.mockReturnValue(platform === "win32" ? { child, job } : undefined);
    vi.spyOn(child, "kill").mockReturnValue(false);
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, received) => {
      expect(pid).toBe(-12345);
      if (descendantOutput.destroyed) {
        throw Object.assign(new Error("group gone"), { code: "ESRCH" });
      }
      if (received !== 0) {
        stopSurvivor();
      }
      return true;
    });
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const outcome = await runManagedCommand({
        bin: "fixture",
        platform,
        shell: false,
        stdio: "pipe",
        requireProcessTreeExit: platform !== "win32",
        cleanupDrainTimeoutMs: 0,
        env: { TMPDIR: root },
        onReady: () => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        },
      }).catch((error: unknown) => error);
      if (platform === "win32") {
        expect(job.stop).toHaveBeenCalledOnce();
        expect(job.close).toHaveBeenCalledOnce();
        if (!terminates) {
          expect(outcome).toMatchObject({ survivingPids: [23456] });
          expect(warning).toHaveBeenCalledWith(
            expect.objectContaining({ survivingPids: [23456], processTreeState: "indeterminate" }),
          );
        }
        expect(inspectManagedProcessGroup(child, { platform, errorPolicy: "indeterminate" })).toBe(
          terminates ? "dead" : "indeterminate",
        );
      } else {
        expect(signal).toHaveBeenCalledWith(-12345, "SIGKILL");
      }
      if (terminates && closes) {
        expect(descendantOutput.destroyed).toBe(true);
        owner.assertReleased();
        // POSIX strict normal-exit policy still reports unexpected group survivors.
        if (platform === "win32") {
          expect(outcome).toBe(0);
        } else {
          expect(outcome).toMatchObject({ processTreeState: "terminated" });
        }
      } else {
        expect(hasUnjoinedWork(outcome)).toBe(true);
        expect(outcome).toMatchObject({ code: "EPROCESSGROUP_CLEANUP_FAILED" });
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      }
    } finally {
      descendantOutput.destroy();
    }
  },
);

it.each([
  [255, "live"],
  [255, "unavailable"],
  [0, "live"],
] as const)(
  "retains a Windows Job after taskkill status %i until independent-output descendants exit (%s observation)",
  async (status, state) => {
    const root = dirs.make("managed-job-retention-");
    const owner = createVitestResourceOwner(root);
    const child = new ChildProcess();
    let exitCode: number | null = null;
    Object.defineProperties(child, {
      pid: { value: 12345 },
      exitCode: { get: () => exitCode },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const descendantOutput = new PassThrough();
    const closed = Promise.all([once(child.stdout, "close"), once(child.stderr, "close")]);
    const observed = createDeferred();
    const job = {
      inspect: vi.fn(() => {
        observed.resolve();
        if (state === "unavailable") {
          throw new Error("Job observation unavailable");
        }
        return [23456];
      }),
      beginStop: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
    };
    mocks.spawn.mockReturnValue(child);
    mocks.spawnWindowsJobChild.mockReturnValue({ child, job });
    vi.spyOn(child, "kill").mockReturnValue(true);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const abort = new AbortController();
    const taskkill = vi.fn(() => {
      exitCode = 0;
      child.emit("exit", 0, null);
      child.stdout?.destroy();
      child.stderr?.destroy();
      return { status, stdout: "leader exited", stderr: status ? "taskkill failed" : "" };
    });
    const completed = runManagedCommand({
      bin: "fixture",
      platform: "win32",
      shell: false,
      stdio: "pipe",
      env: { TMPDIR: root },
      signal: abort.signal,
      runTaskkill: taskkill,
      onReady: () => abort.abort(),
    });
    const outcome = completed.catch((error: unknown) => error);
    try {
      await closed;
      await Promise.race([observed.promise, outcome]);
      expect(descendantOutput.destroyed).toBe(false);
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          processTreeState: "indeterminate",
          survivingPids: state === "live" ? [23456] : undefined,
        }),
      );
      expect(job.close).not.toHaveBeenCalled();
      expect(job.stop).toHaveBeenCalledOnce();
    } finally {
      // This is the independent descendant's completion fact, not elapsed time or leader EOF.
      descendantOutput.destroy();
      job.inspect.mockReturnValue([]);
      await outcome;
    }
    expect(await outcome).toMatchObject({ code: "ABORT_ERR" });
    owner.assertReleased();
    expect(job.close).toHaveBeenCalledOnce();
  },
);
