import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { constants as osConstants } from "node:os";
import process from "node:process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { hasErrnoCode } from "../infra/errno.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as processIdentity from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import {
  COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS,
  COMMAND_PROCESS_TREE_KILL_GRACE_MS,
} from "./exec-spawn.js";
import { createCommandTerminationController } from "./exec-termination.js";
import * as adoptedChildren from "./scoped-child-reaper.js";

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  vi.restoreAllMocks();
});

function terminationOwner(
  child: ChildProcess,
  overrides: Partial<Parameters<typeof createCommandTerminationController>[0]> = {},
) {
  return createCommandTerminationController({
    child,
    cancelController: new AbortController(),
    processTree: { mode: "graceful" },
    killGraceMs: 300,
    isChildExited: () => child.exitCode !== null || child.signalCode !== null,
    isCommandSettled: () => false,
    ...overrides,
  });
}

function mockTerminatingChild(exitCode: number | null = null) {
  const child = Object.assign(new ChildProcess(), { pid: 4242, exitCode });
  const kill = vi.spyOn(child, "kill").mockReturnValue(true);
  vi.spyOn(adoptedChildren, "scheduleAdoptedChildZombieReapAfterExit").mockImplementation(() => {});
  return { child, kill };
}

async function withOwnedTree(
  signal: AbortSignal,
  run: (tree: { parent: ReturnType<typeof spawn>; descendantPid: number }) => Promise<void>,
) {
  const kill = process.kill.bind(process);
  const descendant = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');`;
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');
      process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>process.send(child.pid));setInterval(()=>{},1000);`,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const closed = once(parent, "close");
  const killOwnedGroup = () => {
    // A startup abort can precede descendant readiness; the still-live root owns its group.
    if (parent.pid && parent.exitCode === null && parent.signalCode === null) {
      try {
        kill(-parent.pid, "SIGKILL");
      } catch (error) {
        if (!hasErrnoCode(error, "ESRCH")) {
          throw error;
        }
      }
    }
  };
  let descendantPid: number | undefined;
  try {
    const [message] = await withinTest(
      awaitGateBeforeSettlement(
        once(parent, "message", { signal }),
        closed,
        "Owned tree closed before descendant readiness",
      ),
      signal,
    );
    descendantPid = Number(message);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    await withinTest(run({ parent, descendantPid }), signal);
  } finally {
    killOwnedGroup();
    killPidIfAlive(parent.pid);
    killPidIfAlive(descendantPid);
    await closed;
    if (descendantPid) {
      // The root's close event does not join its orphaned descendant's exit.
      await waitForDead(descendantPid, signal);
      expect(processIdentity.isPidAlive(descendantPid)).toBe(false);
    }
  }
}

describe.skipIf(process.platform === "win32")("command process-group settlement", () => {
  it("retains cleanup ownership when group probes are denied", async () => {
    vi.useFakeTimers();
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(123);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    const { child, kill: killChild } = mockTerminatingChild(7);
    const cancelController = new AbortController();
    const controller = terminationOwner(child, {
      cancelController,
      isChildExited: () => true,
      isCommandSettled: () => true,
    });
    expect(controller.terminate()).toBe(true);
    let settled = false;
    const completion = controller.settle().then((cleanup) => {
      settled = true;
      return cleanup;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(controller.terminate()).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    // Neither live nor EPERM probes prove extinction after the force-send receipt.
    await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(completion).resolves.toBe("uncertain");
    expect(kill.mock.calls.every(([pid]) => pid === -4242)).toBe(true);
    expect(killChild).not.toHaveBeenCalled();
    expect(cancelController.signal.aborted).toBe(false);
  });

  it("accepts confirmed group exit after a denied graceful signal", async () => {
    vi.useFakeTimers();
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(123);
    let gone = false;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(gone ? "group gone" : "group denied"), {
        code: gone ? "ESRCH" : "EPERM",
      });
    });
    const { child } = mockTerminatingChild();
    const owner = terminationOwner(child, { isChildExited: () => child.exitCode !== null });
    expect(owner.terminate()).toBe(true);
    let settled = false;
    const completion = owner.settle().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    child.exitCode = 1;
    gone = true;
    await vi.advanceTimersByTimeAsync(1);
    await expect(completion).resolves.toBe("cooperative");
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it.for(["graceful", "force"] as const)(
    "joins observed group exit after a %s force-send receipt",
    async (mode, { signal: testSignal }) => {
      await withOwnedTree(testSignal, async ({ parent, descendantPid }) => {
        const kill = process.kill.bind(process);
        const forced = createDeferredCore();
        let observedAbsence = false;
        const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (
            pid === -parent.pid! &&
            (signal === "SIGKILL" || signal === osConstants.signals.SIGKILL)
          ) {
            // A successful send is not an exit receipt. Keep this real group alive until released below.
            forced.resolve();
            return true;
          }
          try {
            return kill(pid, signal);
          } catch (error) {
            if (
              pid === -parent.pid! &&
              signal === 0 &&
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            ) {
              observedAbsence = true;
            }
            throw error;
          }
        });
        const owner = terminationOwner(parent, {
          processTree: { mode },
          killGraceMs: 0,
        });
        owner.terminate();
        await forced.promise;
        let settled = false;
        const completion = owner.settle().then((result) => {
          settled = true;
          return { result, observedAbsence };
        });
        await nextTurn();
        expect(processIdentity.isPidAlive(descendantPid)).toBe(true);
        expect.soft(settled).toBe(false);
        kill(-parent.pid!, "SIGKILL");
        const outcome = await completion;
        expect(outcome.result).toBe(outcome.observedAbsence ? "forced" : "uncertain");
        if (outcome.result === "forced") {
          expect(processIdentity.isPidAlive(descendantPid)).toBe(false);
        }
        expect(
          signals.mock.calls.filter(
            ([, signal]) => signal === "SIGKILL" || signal === osConstants.signals.SIGKILL,
          ),
        ).toHaveLength(1);
      });
    },
  );

  it.each([
    { observation: "absent", probeError: "ESRCH", reused: false, expected: "forced" },
    { observation: "reused then absent", probeError: "ESRCH", reused: true, expected: "uncertain" },
  ] as const)(
    "settles a group that becomes $observation during the final identity probe",
    async ({ probeError, reused, expected }) => {
      vi.useFakeTimers();
      let forceSent = false;
      let finalIdentityRead = false;
      vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation(() => {
        if (!forceSent) {
          return 123;
        }
        // A synchronous identity probe can consume the remaining observation budget.
        vi.setSystemTime(Date.now() + COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS);
        finalIdentityRead = true;
        return reused ? 124 : probeError === "ESRCH" ? null : 123;
      });
      const signals = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === "SIGKILL") {
          forceSent = true;
        }
        if (signal === 0 && finalIdentityRead && probeError) {
          throw Object.assign(new Error(probeError), { code: probeError });
        }
        return true;
      });
      const { child } = mockTerminatingChild();
      const owner = terminationOwner(child, {
        processTree: { mode: "force" },
        killGraceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
        isChildExited: () => false,
      });
      owner.terminate();
      await expect(owner.settle()).resolves.toBe(expected);
      expect(signals.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([
        [-child.pid, "SIGKILL"],
      ]);
      expect(signals.mock.calls.every(([pid]) => pid === -child.pid)).toBe(true);
    },
  );

  it("preserves normal cleanup for a retired group", async () => {
    const parent = spawn(
      process.execPath,
      ["-e", "process.on('message',()=>process.exit(0));process.send('ready');"],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const closed = once(parent, "close");
    try {
      await once(parent, "message", { signal: AbortSignal.timeout(2_000) });
      const owner = terminationOwner(parent, {
        killGraceMs: 0,
      });
      parent.send("finish");
      await closed;
      const signals = vi.spyOn(process, "kill");
      owner.terminate();
      expect(await owner.settle()).toBe("normal");
      expect(signals.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      killPidIfAlive(parent.pid);
      await closed;
    }
  });

  it.for([{ observation: "live" }, { observation: "reused" }] as const)(
    "reports uncertainty when the group remains $observation after force",
    async ({ observation }, { signal: testSignal }) => {
      await withOwnedTree(testSignal, async ({ parent, descendantPid }) => {
        const kill = process.kill.bind(process);
        const readStart = processIdentity.getFileLockProcessStartTime;
        const originalStart = readStart(parent.pid!);
        expect(originalStart).not.toBeNull();
        let forced = false;
        const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (
            pid === -parent.pid! &&
            (signal === "SIGKILL" || signal === osConstants.signals.SIGKILL)
          ) {
            forced = true;
            return true;
          }
          return kill(pid, signal);
        });
        vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation(
          (pid, ...args) =>
            forced && observation === "reused" && pid === parent.pid
              ? originalStart! + 1
              : readStart(pid, ...args),
        );
        const owner = terminationOwner(parent, {
          killGraceMs: 0,
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
        try {
          owner.terminate();
          const completion = owner.settle();
          await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS);
          expect(await completion).toBe("uncertain");
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
        expect(processIdentity.isPidAlive(descendantPid)).toBe(true);
        expect(
          signals.mock.calls.filter(
            ([, signal]) => signal === "SIGKILL" || signal === osConstants.signals.SIGKILL,
          ),
        ).toHaveLength(1);
      });
    },
  );
});
