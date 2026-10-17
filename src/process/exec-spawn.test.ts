import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { setImmediate, setTimeout as waitForProcessTick } from "node:timers/promises";
import { expect, it, vi, type MockInstance } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import * as processIdentity from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { isChildProcessTreeAlive } from "./child-process-tree.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import { spawnCommand, withCommandProcessScope } from "./exec-spawn.js";

const idleScript = "setInterval(()=>{},1000)";
const readyScript = `process.send('ready');${idleScript}`;
type Command = ReturnType<typeof spawnCommand>;
function spawnScript(script = idleScript, options: Parameters<typeof spawnCommand>[1] = {}) {
  return spawnCommand([process.execPath, "-e", script], {
    reject: false,
    stdio: "ignore",
    ...options,
  });
}
const spawnReady = (signal: AbortSignal) =>
  spawnScript(readyScript, { cancelSignal: signal, ipc: true, timeout: 3_000 });
const ready = (child: ChildProcess) =>
  once(child, "message", { signal: AbortSignal.timeout(3_000) });
const expectClosed = () => expect(() => spawnScript("")).toThrow("Command process scope is closed");
const endings = [
  ["explicit", false],
  ["resolve", true],
  ["reject", false],
  ["explicit", false, "initially-missing"],
  ["explicit", true, "reused-after-exit"],
  ["resolve", true, "reused-after-extinction"],
] as const;

it.each([
  ["scope", false],
  ["scope", true],
  ["caller", false],
] as const)("isolates %s cancellation (nested: %s)", async (source, nested) => {
  const controller = new AbortController();
  const caller = new AbortController();
  let command: Command | undefined;
  let sibling: Command | undefined;
  const run = async () => {
    sibling = source === "caller" ? spawnScript() : undefined;
    command = spawnReady(caller.signal);
    await ready(command.nodeChildProcess);
    (source === "scope" ? controller : caller).abort();
    expect(await command).toMatchObject({ isCanceled: true, timedOut: false });
    expect((source === "scope" ? caller : controller).signal.aborted).toBe(false);
    expect(processIdentity.isPidAlive(command.pid!)).toBe(false);
    if (sibling) {
      expect(processIdentity.isPidAlive(sibling.pid!)).toBe(true);
      killPidIfAlive(sibling.pid);
      await sibling;
      sibling = undefined;
    } else {
      expectClosed();
    }
  };
  try {
    await withCommandProcessScope(
      () => (nested ? withCommandProcessScope(run) : run()),
      controller.signal,
    );
  } finally {
    for (const target of [command, sibling]) {
      killPidIfAlive(target?.pid);
    }
    await Promise.all([command, sibling]);
  }
});

it.each(["scope", "caller"] as const)("joins nested %s cancellation", async (source) => {
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
});
it.skipIf(process.platform === "win32").for(endings)(
  "settles ownership: %j",
  async ([completion, exitParent, ...identities], { signal: testSignal }) => {
    const identity = identities[0];
    const unrelated = spawnScript();
    let command: Command | undefined;
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
        command = spawnScript(
          `const {spawn}=require('node:child_process');
              process.on('SIGTERM',()=>{});
              const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
              child.once('message',()=>process.send(child.pid,()=>{${exitParent ? "child.disconnect();process.exit(0)" : "setInterval(()=>{},1000)"}}));`,
          { stdio: ["ignore", "pipe", "pipe"], ipc: true, reject: false },
        );
        const child = command.nodeChildProcess;
        const [message] = await awaitGateBeforeSettlement(
          once(child, "message", { signal: testSignal }),
          command,
          "Scope did not receive its descendant PID",
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
            while (isChildProcessTreeAlive(child)) {
              await waitForProcessTick(25, undefined, { signal: testSignal });
            }
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
      await command;
      expect(processIdentity.isPidAlive(unrelated.pid!)).toBe(true);
      if (retiredSignals) {
        expect(
          retiredSignals.mock.calls.filter(
            ([pid, signal]) => Math.abs(pid) === command?.pid && signal !== 0,
          ),
        ).toEqual([]);
      }
    } finally {
      retiredSignals?.mockRestore();
      identityProbe.mockRestore();
      killPidIfAlive(command?.pid);
      killPidIfAlive(descendantPid);
      killPidIfAlive(unrelated.pid);
      await command;
      await unrelated;
    }
  },
);
