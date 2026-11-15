import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { setImmediate, setTimeout as waitForProcessTick } from "node:timers/promises";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import * as processIdentity from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { isChildProcessTreeAlive } from "./child-process-tree.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import { spawnCommand, withCommandProcessScope } from "./exec-spawn.js";
import { isProcessGroupGoneByCensus } from "./supervisor/service-child-group-ownership.js";

// Wrap the real census so tests can tell whether the kernel probe alone settled a group.
vi.mock("./supervisor/service-child-group-ownership.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./supervisor/service-child-group-ownership.js")>();
  return { ...actual, isProcessGroupGoneByCensus: vi.fn(actual.isProcessGroupGoneByCensus) };
});

// A foreign descendant has no retained ChildProcess handle after its root exits.
async function waitForGroupExit(child: ChildProcess, signal: AbortSignal): Promise<void> {
  try {
    while (isChildProcessTreeAlive(child)) {
      await waitForProcessTick(25, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`Timed out waiting for process group ${child.pid} to exit`, { cause: error });
  }
}

type ScopeCase = {
  name: string;
  exitParent: boolean;
  completion: "explicit" | "resolve" | "reject";
  identity?: "initially-missing" | "reused-after-exit" | "reused-after-extinction";
};

const endings: ScopeCase[] = (
  [
    ["explicit", false],
    ["resolve", true],
    ["reject", false],
  ] as const
).map(([completion, exitParent]) => ({
  name: `stops owned descendants on ${completion} without stopping another command (parent exited: ${exitParent})`,
  exitParent,
  completion,
}));
endings.push(
  {
    name: "stops a live child when its initial start-time probe failed",
    exitParent: false,
    completion: "explicit",
    identity: "initially-missing",
  },
  {
    name: "preserves a retained group when an exited root has a different identity",
    exitParent: true,
    completion: "explicit",
    identity: "reused-after-exit",
  },
  {
    name: "finishes an extinct retained group without signalling a reused root PID",
    exitParent: true,
    completion: "resolve",
    identity: "reused-after-extinction",
  },
);

describe("command process scope cancellation", () => {
  it.each([false, true])(
    "cancels a running command through its scope (nested: %s)",
    async (nested) => {
      const controller = new AbortController();
      const caller = new AbortController();
      let child: ChildProcess | undefined;
      let childResult: Promise<unknown> | undefined;
      const run = async () => {
        const command = spawnCommand(
          [process.execPath, "-e", "process.send('ready');setInterval(()=>{},1000)"],
          {
            cancelSignal: caller.signal,
            ipc: true,
            reject: false,
            stdio: "ignore",
            timeout: 3_000,
          },
        );
        child = command.nodeChildProcess;
        childResult = command;
        await once(child, "message", { signal: AbortSignal.timeout(3_000) });
        controller.abort();
        expect(await command).toMatchObject({ isCanceled: true, timedOut: false });
        expect(caller.signal.aborted).toBe(false);
        expect(processIdentity.isPidAlive(child.pid!)).toBe(false);
        expect(() => spawnCommand([process.execPath, "-e", ""])).toThrow(
          "Command process scope is closed",
        );
      };
      try {
        await withCommandProcessScope(
          () => (nested ? withCommandProcessScope(run) : run()),
          controller.signal,
        );
      } finally {
        killPidIfAlive(child?.pid);
        await childResult;
      }
    },
  );

  it("preserves caller cancellation without stopping a sibling command", async () => {
    const controller = new AbortController();
    const caller = new AbortController();
    await withCommandProcessScope(async () => {
      const sibling = spawnCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        reject: false,
        stdio: "ignore",
      });
      const child = spawnCommand(
        [process.execPath, "-e", "process.send('ready');setInterval(()=>{},1000)"],
        { cancelSignal: caller.signal, ipc: true, reject: false, stdio: "ignore", timeout: 3_000 },
      );
      try {
        await once(child.nodeChildProcess, "message", { signal: AbortSignal.timeout(3_000) });
        caller.abort();
        expect(await child).toMatchObject({ isCanceled: true, timedOut: false });
        expect(controller.signal.aborted).toBe(false);
        expect(processIdentity.isPidAlive(sibling.pid!)).toBe(true);
      } finally {
        killPidIfAlive(child.pid);
        killPidIfAlive(sibling.pid);
        await Promise.all([child, sibling]);
      }
    }, controller.signal);
  });

  it.each(["scope", "caller"] as const)(
    "joins command-runner termination after nested %s cancellation",
    async (source) => {
      const controller = new AbortController();
      const caller = new AbortController();
      let childPid: number | undefined;
      try {
        await withCommandProcessScope(
          () =>
            withCommandProcessScope(async () => {
              let output = "";
              const result = await runCommandWithTimeout(
                [
                  process.execPath,
                  "-e",
                  "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)",
                ],
                {
                  signal: caller.signal,
                  killProcessTree: true,
                  timeoutMs: 3_000,
                  onOutputChunk: (chunk) => {
                    output += chunk.toString();
                    if (output.includes("\n") && childPid === undefined) {
                      childPid = Number(output.trim());
                      (source === "scope" ? controller : caller).abort();
                    }
                  },
                },
              );
              expect(result).toMatchObject({ termination: "signal", cleanup: "forced" });
              expect(Number.isSafeInteger(childPid)).toBe(true);
              expect(processIdentity.isPidAlive(childPid!)).toBe(false);
            }),
          controller.signal,
        );
      } finally {
        killPidIfAlive(childPid);
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("terminal command process ownership", () => {
  it.for(endings)("$name", async ({ exitParent, completion, identity }, { signal: testSignal }) => {
    vi.mocked(isProcessGroupGoneByCensus).mockClear();
    const unrelated = spawnCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      reject: false,
    });
    let child: ChildProcess | undefined;
    let childResult: Promise<unknown> | undefined;
    let descendantPid: number | undefined;
    let retiredSignals: MockInstance<typeof process.kill> | undefined;
    const failure = new Error("scope fixture failure");
    const identityProbe = vi.spyOn(processIdentity, "getFileLockProcessStartTime");
    if (identity === "initially-missing") {
      identityProbe.mockReturnValueOnce(null);
    } else if (identity === "reused-after-exit" || identity === "reused-after-extinction") {
      identityProbe.mockReturnValue(1);
    }
    try {
      const running = withCommandProcessScope(async (stop) => {
        const descendant =
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');";
        const command = spawnCommand(
          [
            process.execPath,
            "-e",
            `const {spawn}=require('node:child_process');
              process.on('SIGTERM',()=>{});
              const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
              child.once('message',()=>process.send(child.pid,()=>{${exitParent ? "child.disconnect();process.exit(0)" : "setInterval(()=>{},1000)"}}));`,
          ],
          { stdio: ["ignore", "pipe", "pipe"], ipc: true, reject: false },
        );
        child = command.nodeChildProcess;
        childResult = command;
        const [message] = await withinTest(
          awaitGateBeforeSettlement(
            once(child, "message", { signal: testSignal }),
            command,
            "Scope did not receive its descendant PID",
          ),
          testSignal,
        );
        descendantPid = Number(message);
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        if (exitParent) {
          await command;
        }
        if (identity === "reused-after-exit" || identity === "reused-after-extinction") {
          expect(child.exitCode).toBe(0);
          if (identity === "reused-after-extinction") {
            await setImmediate();
            // Real process-group extinction is required before simulating PID reuse.
            expect(isChildProcessTreeAlive(child)).toBe(true);
            process.kill(descendantPid, "SIGKILL");
            // Group absence also joins adopted-child reaping, which PID liveness alone cannot prove.
            await waitForGroupExit(child, testSignal);
            expect(processIdentity.isPidAlive(descendantPid)).toBe(false);
            const kill = process.kill.bind(process);
            let groupReads = 0;
            retiredSignals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
              // Once the absent group is observed, its numeric ID can be reused too.
              if (pid === -child!.pid! && signal === 0 && groupReads++ > 0) {
                return true;
              }
              return kill(pid, signal);
            });
          }
          identityProbe.mockReturnValue(2);
        }
        expect(processIdentity.isPidAlive(descendantPid)).toBe(
          identity !== "reused-after-extinction",
        );
        if (completion === "explicit") {
          stop();
          expect(() => spawnCommand([process.execPath, "-e", ""])).toThrow(
            "Command process scope is closed",
          );
        } else if (completion === "reject") {
          throw failure;
        }
      });
      if (identity === "reused-after-exit") {
        await expect(withinTest(running, testSignal)).rejects.toMatchObject({
          code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
        });
      } else if (completion === "reject") {
        await expect(withinTest(running, testSignal)).rejects.toBe(failure);
      } else {
        await withinTest(running, testSignal);
      }
      if (descendantPid === undefined) {
        throw new Error("Scope did not receive its descendant PID");
      }
      // Scope settlement joins group extinction, or rejects without signaling the reused identity.
      expect(processIdentity.isPidAlive(descendantPid)).toBe(identity === "reused-after-exit");
      await childResult;
      expect(processIdentity.isPidAlive(unrelated.pid!)).toBe(true);
      // The kernel group probe answers here; the census is only the denied-probe fallback.
      expect(isProcessGroupGoneByCensus).not.toHaveBeenCalled();
      if (retiredSignals) {
        expect(
          retiredSignals.mock.calls.filter(
            ([pid, signal]) => Math.abs(pid) === child?.pid && signal !== 0,
          ),
        ).toEqual([]);
      }
    } finally {
      retiredSignals?.mockRestore();
      identityProbe.mockRestore();
      killPidIfAlive(child?.pid);
      killPidIfAlive(descendantPid);
      killPidIfAlive(unrelated.pid);
      await childResult;
      await unrelated;
    }
  });
});

describe.skipIf(process.platform !== "linux")("denied process-group probes", () => {
  it("keeps a group alive on a kernel EPERM without consulting the census", () => {
    vi.mocked(isProcessGroupGoneByCensus).mockClear();
    const pgid = 123_456_789;
    // A member owned by another UID makes the kernel answer EPERM for this group only;
    // the out-of-range canary group still gets the kernel's ESRCH, so the host is not denying probes.
    const kernel = vi.spyOn(process, "kill").mockImplementation((pid) => {
      throw Object.assign(new Error(pid === -pgid ? "kill EPERM" : "kill ESRCH"), {
        code: pid === -pgid ? "EPERM" : "ESRCH",
        syscall: "kill",
      });
    });
    try {
      expect(isChildProcessTreeAlive({ pid: pgid })).toBe(true);
      expect(isProcessGroupGoneByCensus).not.toHaveBeenCalled();
    } finally {
      kernel.mockRestore();
    }
  });

  it(
    "settles a scope from the process census when negative-PID probes return EPERM",
    { timeout: 15_000 },
    async ({ signal: testSignal }) => {
      vi.mocked(isProcessGroupGoneByCensus).mockClear();
      let descendantPid: number | undefined;
      const kill = process.kill.bind(process);
      // OpenShell's seccomp rule denies group-wide kill(2) and probes with EPERM.
      const denied = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0) {
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
        }
        return kill(pid, signal);
      });
      try {
        await withinTest(
          withCommandProcessScope(async () => {
            // The root exits at once; its descendant keeps the group alive.
            const descendant = "setInterval(()=>{},1000)";
            const command = spawnCommand(
              [
                process.execPath,
                "-e",
                `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});c.unref();console.log(c.pid)`,
              ],
              { stdio: ["ignore", "pipe", "ignore"], reject: false },
            );
            const { stdout } = await command;
            descendantPid = Number(stdout);
            // EPERM alone proves nothing: only the census can see the live descendant.
            expect(isChildProcessTreeAlive(command.nodeChildProcess)).toBe(true);
            expect(isProcessGroupGoneByCensus).toHaveBeenCalled();
            process.kill(descendantPid, "SIGKILL");
          }),
          testSignal,
        );
      } finally {
        denied.mockRestore();
        killPidIfAlive(descendantPid);
      }
      expect(processIdentity.isPidAlive(descendantPid!)).toBe(false);
    },
  );
});
