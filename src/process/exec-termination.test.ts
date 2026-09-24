import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants as osConstants } from "node:os";
import process from "node:process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as processIdentity from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS } from "./exec-spawn.js";
import { createCommandTerminationController } from "./exec-termination.js";

afterEach(() => vi.restoreAllMocks());

async function withOwnedTree(
  run: (tree: { parent: ReturnType<typeof spawn>; descendantPid: number }) => Promise<void>,
) {
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
  let descendantPid: number | undefined;
  try {
    const [message] = await once(parent, "message", { signal: AbortSignal.timeout(2_000) });
    descendantPid = Number(message);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    await run({ parent, descendantPid });
  } finally {
    killPidIfAlive(parent.pid);
    killPidIfAlive(descendantPid);
    await closed;
    if (descendantPid) {
      expect(await waitForPidToExit(descendantPid)).toBe(true);
    }
  }
}

describe.skipIf(process.platform === "win32")("command process-group settlement", () => {
  it.each([
    { name: "an absent group", probeError: "ESRCH", needsGrace: false },
    { name: "surviving descendants", probeError: undefined, needsGrace: true },
    { name: "a permission-denied group", probeError: "EPERM", needsGrace: true },
  ])(
    "settles $name after a failed root without losing cleanup ownership",
    async ({ probeError, needsGrace }) => {
      vi.useFakeTimers();
      vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(123);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        if (probeError) {
          throw Object.assign(new Error(probeError), { code: probeError });
        }
        return true;
      });
      const child = { pid: 4242, exitCode: 7, signalCode: null, kill: vi.fn(() => true) };
      const cancelController = new AbortController();
      const controller = createCommandTerminationController({
        child,
        cancelController,
        processTree: { mode: "graceful" },
        killGraceMs: 300,
        isChildExited: () => true,
        isCommandSettled: () => true,
      });
      try {
        expect(controller.terminate()).toBe(needsGrace);
        let settled = false;
        const completion = controller.settle().then((cleanup) => {
          settled = true;
          return cleanup;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(!needsGrace);
        expect(controller.terminate()).toBe(needsGrace);
        if (needsGrace) {
          expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
        } else {
          expect(kill).not.toHaveBeenCalledWith(-4242, "SIGTERM");
        }
        expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
        await vi.advanceTimersByTimeAsync(299);
        expect(settled).toBe(!needsGrace);
        expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(!needsGrace);
        if (needsGrace) {
          expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
        } else {
          expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
        }
        // Neither live nor EPERM probes prove extinction after the force-send receipt.
        await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_TREE_KILL_GRACE_MS - 1);
        expect(settled).toBe(!needsGrace);
        await vi.advanceTimersByTimeAsync(1);
        await expect(completion).resolves.toBe(needsGrace ? "uncertain" : "normal");
        expect(kill.mock.calls.every(([pid]) => pid === -4242)).toBe(true);
        expect(child.kill).not.toHaveBeenCalled();
        expect(cancelController.signal.aborted).toBe(false);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("accepts confirmed group exit after a denied graceful signal", async () => {
    vi.useFakeTimers();
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(123);
    let gone = false;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(gone ? "group gone" : "group denied"), {
        code: gone ? "ESRCH" : "EPERM",
      });
    });
    const child: { pid: number; exitCode: number | null; signalCode: null } = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
    };
    const owner = createCommandTerminationController({
      child,
      cancelController: new AbortController(),
      processTree: { mode: "graceful" },
      killGraceMs: 300,
      isChildExited: () => child.exitCode !== null,
      isCommandSettled: () => false,
    });
    try {
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
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["graceful", "force"] as const)(
    "joins observed group exit after a %s force-send receipt",
    async (mode) => {
      await withOwnedTree(async ({ parent, descendantPid }) => {
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
        const owner = createCommandTerminationController({
          child: parent,
          cancelController: new AbortController(),
          processTree: { mode },
          killGraceMs: 0,
          isChildExited: () => parent.exitCode !== null || parent.signalCode !== null,
          isCommandSettled: () => false,
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
    { observation: "live", probeError: undefined, reused: false, expected: "uncertain" },
    { observation: "inaccessible", probeError: "EPERM", reused: false, expected: "uncertain" },
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
        vi.setSystemTime(Date.now() + COMMAND_PROCESS_TREE_KILL_GRACE_MS);
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
      const child = { pid: 4242, exitCode: null, signalCode: null };
      const owner = createCommandTerminationController({
        child,
        cancelController: new AbortController(),
        processTree: { mode: "force" },
        killGraceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
        isChildExited: () => false,
        isCommandSettled: () => false,
      });
      try {
        owner.terminate();
        await expect(owner.settle()).resolves.toBe(expected);
        expect(signals.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([
          [-child.pid, "SIGKILL"],
        ]);
        expect(signals.mock.calls.every(([pid]) => pid === -child.pid)).toBe(true);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { mode: "graceful", killSignal: undefined },
    { mode: "force", killSignal: undefined },
    { mode: "graceful", killSignal: "SIGKILL" },
    { mode: "graceful", killSignal: osConstants.signals.SIGKILL },
  ] as const)(
    "preserves normal cleanup for a retired group (mode=$mode signal=$killSignal)",
    async ({ mode, killSignal }) => {
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
        const owner = createCommandTerminationController({
          child: parent,
          cancelController: new AbortController(),
          processTree: { mode },
          killSignal,
          killGraceMs: 0,
          isChildExited: () => parent.exitCode !== null || parent.signalCode !== null,
          isCommandSettled: () => false,
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
    },
  );

  it.each([
    { observation: "live", killSignal: undefined },
    { observation: "unknown", killSignal: undefined },
    { observation: "reused", killSignal: undefined },
    { observation: "live", killSignal: "SIGKILL" },
    { observation: "live", killSignal: osConstants.signals.SIGKILL },
  ] as const)(
    "reports uncertain when the original group remains $observation after force (initial signal=$killSignal)",
    async ({ observation, killSignal }) => {
      await withOwnedTree(async ({ parent, descendantPid }) => {
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
          if (forced && pid === -parent.pid! && signal === 0 && observation === "unknown") {
            throw Object.assign(new Error("fixture observation unavailable"), { code: "EPERM" });
          }
          return kill(pid, signal);
        });
        vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation(
          (pid, ...args) =>
            forced && observation === "reused" && pid === parent.pid
              ? originalStart! + 1
              : readStart(pid, ...args),
        );
        const owner = createCommandTerminationController({
          child: parent,
          cancelController: new AbortController(),
          processTree: { mode: "graceful" },
          killSignal,
          killGraceMs: 0,
          isChildExited: () => parent.exitCode !== null || parent.signalCode !== null,
          isCommandSettled: () => false,
        });
        owner.terminate();
        expect(await owner.settle()).toBe("uncertain");
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
