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
import { COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS } from "./exec-spawn.js";
import { createCommandTerminationController } from "./exec-termination.js";
import * as adoptedChildren from "./scoped-child-reaper.js";

const isForceSignal = (signal: Parameters<typeof process.kill>[1]) =>
  signal === "SIGKILL" || signal === osConstants.signals.SIGKILL;

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

const spawnRoot = (source: string) =>
  spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });

async function withOwnedTree(
  signal: AbortSignal,
  run: (tree: { parent: ReturnType<typeof spawn>; descendantPid: number }) => Promise<void>,
) {
  const kill = process.kill.bind(process);
  const descendant = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');`;
  const parent = spawnRoot(
    `const {spawn}=require('node:child_process');
      process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>process.send(child.pid));setInterval(()=>{},1000);`,
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
  it.each([false, true])("settles denied groups (exits during grace: %s)", async (exits) => {
    vi.useFakeTimers();
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(123);
    let gone = false;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const code = gone ? "ESRCH" : "EPERM";
      throw Object.assign(new Error(code), { code });
    });
    const { child, kill: killChild } = mockTerminatingChild(exits ? null : 7);
    const cancelController = new AbortController();
    const owner = terminationOwner(child, {
      cancelController,
      isChildExited: () => (exits ? child.exitCode !== null : true),
      isCommandSettled: () => !exits,
    });
    expect(owner.terminate()).toBe(true);
    let settled = false;
    const completion = owner.settle().then((result) => {
      settled = true;
      return result;
    });
    if (exits) {
      await vi.advanceTimersByTimeAsync(24);
      expect(settled).toBe(false);
      child.exitCode = 1;
      gone = true;
      await vi.advanceTimersByTimeAsync(1);
      await expect(completion).resolves.toBe("cooperative");
      expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
    } else {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(owner.terminate()).toBe(true);
      expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBe(false);
      expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
      // Force-send and EPERM are not evidence of extinction.
      await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(completion).resolves.toBe("uncertain");
      expect(kill.mock.calls.every(([pid]) => pid === -4242)).toBe(true);
      expect(killChild).not.toHaveBeenCalled();
      expect(cancelController.signal.aborted).toBe(false);
    }
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
  });
  it.for([
    { mode: "graceful", observation: "exit" },
    { mode: "force", observation: "exit" },
    { mode: "graceful", observation: "live" },
    { mode: "graceful", observation: "reused" },
  ] as const)(
    "joins $mode force cleanup with a group that is $observation",
    async ({ mode, observation }, { signal: testSignal }) => {
      await withOwnedTree(testSignal, async ({ parent, descendantPid }) => {
        const kill = process.kill.bind(process);
        const readStart = processIdentity.getFileLockProcessStartTime;
        const originalStart = observation === "exit" ? null : readStart(parent.pid!);
        if (observation !== "exit") {
          expect(originalStart).not.toBeNull();
        }
        const forced = createDeferredCore();
        let forceSent = false;
        let observedAbsence = false;
        const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === -parent.pid! && isForceSignal(signal)) {
            // Sending is not an exit receipt: release the real group explicitly below.
            forceSent = true;
            forced.resolve();
            return true;
          }
          try {
            return kill(pid, signal);
          } catch (error) {
            if (pid === -parent.pid! && signal === 0 && hasErrnoCode(error, "ESRCH")) {
              observedAbsence = true;
            }
            throw error;
          }
        });
        if (observation !== "exit") {
          vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation(
            (pid, ...args) =>
              forceSent && observation === "reused" && pid === parent.pid
                ? originalStart! + 1
                : readStart(pid, ...args),
          );
        }
        const owner = terminationOwner(parent, { processTree: { mode }, killGraceMs: 0 });
        if (observation === "exit") {
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
        } else {
          vi.useFakeTimers({ toFake: ["setTimeout", "Date", "performance"] });
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
        }
        expect(signals.mock.calls.filter(([, signal]) => isForceSignal(signal))).toHaveLength(1);
      });
    },
  );
  it.each([
    { observation: "absent", reused: false, expected: "forced" },
    { observation: "reused then absent", reused: true, expected: "uncertain" },
  ] as const)("final identity probe: $observation", async ({ reused, expected }) => {
    vi.useFakeTimers();
    let forceSent = false;
    let finalIdentityRead = false;
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation(() => {
      if (!forceSent) {
        return 123;
      }
      // A synchronous identity probe can consume the remaining observation budget.
      vi.advanceTimersByTime(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS);
      finalIdentityRead = true;
      return reused ? 124 : null;
    });
    const signals = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") {
        forceSent = true;
      }
      if (signal === 0 && finalIdentityRead) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    });
    const { child } = mockTerminatingChild();
    const owner = terminationOwner(child, {
      processTree: { mode: "force" },
      isChildExited: () => false,
    });
    owner.terminate();
    await expect(owner.settle()).resolves.toBe(expected);
    expect(signals.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([
      [-child.pid, "SIGKILL"],
    ]);
    expect(signals.mock.calls.every(([pid]) => pid === -child.pid)).toBe(true);
  });

  it("keeps kill grace and exit confirmation bounded when the wall clock rewinds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(123);
    const signals = vi.spyOn(process, "kill").mockReturnValue(true);
    const owner = terminationOwner(mockTerminatingChild().child, { isChildExited: () => false });
    const rewindWallClock = () => vi.setSystemTime(Date.now() - 60_000);
    owner.terminate();
    rewindWallClock();
    await vi.advanceTimersByTimeAsync(300);
    expect(signals.mock.calls.filter(([, signal]) => isForceSignal(signal))).toHaveLength(1);
    let settled = false;
    const completion = owner.settle().finally(() => {
      settled = true;
    });
    rewindWallClock();
    await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS);
    expect(settled).toBe(true);
    await expect(completion).resolves.toBe("uncertain");
  });

  it("preserves normal cleanup for a retired group", async () => {
    const parent = spawnRoot("process.on('message',()=>process.exit(0));process.send('ready');");
    const closed = once(parent, "close");
    try {
      await once(parent, "message", { signal: AbortSignal.timeout(2_000) });
      const owner = terminationOwner(parent, { killGraceMs: 0 });
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
});
