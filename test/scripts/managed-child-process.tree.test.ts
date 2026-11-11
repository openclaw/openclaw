import { ChildProcess, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createSyntheticChild,
  psResult,
  runFixtureCommand,
} from "./managed-child-process.test-support.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnWindowsJobChild: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  spawnSync: vi.fn(),
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
  const command = runFixtureCommand({
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

it("preserves deferred spawn errors and releases ownership when output streams were never created", async () => {
  const root = dirs.make("managed-spawn-no-streams-");
  const owner = createVitestResourceOwner(root);
  const child = new ChildProcess();
  const failure = Object.assign(new Error("file descriptor limit reached"), { code: "EMFILE" });
  // Node returns before creating stdout/stderr on EMFILE/ENFILE, then emits error.
  const emitted = once(child, "error");
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = signals.map((signal) => process.listenerCount(signal));
  mocks.spawn.mockImplementation(() => {
    process.nextTick(() => child.emit("error", failure));
    return child;
  });
  const outcome = runFixtureCommand({
    platform: "darwin",
    stdio: "pipe",
    env: { TMPDIR: root },
  }).catch((error: unknown) => error);
  await emitted;
  expect(await outcome).toBe(failure);
  owner.assertReleased();
  expect(signals.map((signal) => process.listenerCount(signal))).toEqual(listeners);
});

it("preserves requested command inputs across Windows platform loading", async () => {
  const root = dirs.make("managed-platform-inputs-");
  const { child, close } = createSyntheticChild("none", 0);
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
  const command = runFixtureCommand({
    args,
    env,
    platform: "win32",
    onReady: close,
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
    const { child, close } = createSyntheticChild("none", 0);
    const groupError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
    const leaderError = Object.assign(new Error("leader signal denied"), { code: "EACCES" });
    mocks.spawn.mockReturnValue(child);
    let fallbackAttempted = false;
    vi.mocked(spawnSync).mockReturnValue(psResult("", { status: 1 }));
    const leaderSignal = vi.spyOn(child, "kill").mockImplementation(() => {
      fallbackAttempted = true;
      if (leaderSignalFails) {
        throw leaderError;
      }
      return false;
    });
    const groupSignal = vi.spyOn(process, "kill").mockImplementation((_pid, received) => {
      if (received === 0) {
        throw Object.assign(new Error("group observation"), {
          code: fallbackAttempted ? "ESRCH" : "EPERM",
        });
      }
      throw groupError;
    });

    await expect(
      runFixtureCommand({
        platform: "darwin",
        requireProcessTreeExit: true,
        env: { TMPDIR: root },
        onReady: close,
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
    expect(groupSignal).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(leaderSignal).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    owner.assertReleased();
  },
);

it("retains ownership when a terminated Windows Job handle cannot close", async () => {
  const root = dirs.make("managed-normal-exit-");
  const owner = createVitestResourceOwner(root);
  const { child, close } = createSyntheticChild("none", 0);
  let stopped = false;
  const job = {
    inspect: vi.fn(() => (stopped ? [] : [23456])),
    beginStop: vi.fn(),
    stop: vi.fn(() => {
      stopped = true;
    }),
    close: vi.fn(() => {
      throw new Error("CloseHandle failed");
    }),
  };
  mocks.spawnWindowsJobChild.mockReturnValue({ child, job });
  const outcome = await runFixtureCommand({
    platform: "win32",
    cleanupDrainTimeoutMs: 0,
    env: { TMPDIR: root },
    onReady: close,
  }).catch((error: unknown) => error);
  expect(job.stop).toHaveBeenCalledOnce();
  expect(job.close).toHaveBeenCalledOnce();
  expect(stopped).toBe(true);
  expect(
    inspectManagedProcessGroup(child, { platform: "win32", errorPolicy: "indeterminate" }),
  ).toBe("dead");
  expect(hasUnjoinedWork(outcome)).toBe(true);
  expect(outcome).toMatchObject({ code: "EPROCESSGROUP_CLEANUP_FAILED" });
  expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
});

it.each([
  [255, "unavailable"],
  [0, "live"],
] as const)(
  "retains a Windows Job after taskkill status %i until independent-output descendants exit (%s observation)",
  async (status, state) => {
    const root = dirs.make("managed-job-retention-");
    const owner = createVitestResourceOwner(root);
    const { child, exit, waitForOutputClose, destroyOutput } = createSyntheticChild("both");
    const closed = waitForOutputClose();
    void closed.then(() => child.emit("close", child.exitCode, null));
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
      exit();
      destroyOutput();
      return { status, stdout: "leader exited", stderr: status ? "taskkill failed" : "" };
    });
    const completed = runFixtureCommand({
      platform: "win32",
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
      job.inspect.mockReturnValue([]);
      await outcome;
    }
    expect(await outcome).toMatchObject({ code: "ABORT_ERR" });
    owner.assertReleased();
    expect(job.close).toHaveBeenCalledOnce();
  },
);
