import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import * as processIdentity from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import { spawnCommand, withCommandProcessScope } from "./exec-spawn.js";

type ScopeCase = {
  name: string;
  exitParent: boolean;
  completion: "explicit" | "resolve" | "reject";
  identity?: "initially-missing" | "reused-after-exit";
};

const endings: ScopeCase[] = [false, true].flatMap((exitParent) =>
  (["explicit", "resolve", "reject"] as const).map((completion) => ({
    name: `stops owned descendants on ${completion} without stopping another command (parent exited: ${exitParent})`,
    exitParent,
    completion,
  })),
);
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
  it.each(endings)("$name", async ({ exitParent, completion, identity }) => {
    const unrelated = spawnCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      reject: false,
    });
    let child: ChildProcess | undefined;
    let childResult: Promise<unknown> | undefined;
    let descendantPid: number | undefined;
    const failure = new Error("scope fixture failure");
    const identityProbe = vi.spyOn(processIdentity, "getFileLockProcessStartTime");
    if (identity === "initially-missing") {
      identityProbe.mockReturnValueOnce(null);
    } else if (identity === "reused-after-exit") {
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
        const [message] = await once(child, "message", {
          signal: AbortSignal.timeout(3_000),
        });
        descendantPid = Number(message);
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        if (exitParent) {
          await command;
        }
        if (identity === "reused-after-exit") {
          expect(child.exitCode).toBe(0);
          identityProbe.mockReturnValue(2);
        }
        expect(processIdentity.isPidAlive(descendantPid)).toBe(true);
        if (completion === "explicit") {
          stop();
          expect(() => spawnCommand([process.execPath, "-e", ""])).toThrow(
            "Command process scope is closed",
          );
        } else if (completion === "reject") {
          throw failure;
        }
      });
      if (completion === "reject") {
        await expect(running).rejects.toBe(failure);
      } else {
        await running;
      }
      if (descendantPid === undefined) {
        throw new Error("Scope did not receive its descendant PID");
      }
      expect(await waitForPidToExit(descendantPid)).toBe(identity !== "reused-after-exit");
      await childResult;
      expect(processIdentity.isPidAlive(unrelated.pid!)).toBe(true);
    } finally {
      identityProbe.mockRestore();
      killPidIfAlive(child?.pid);
      killPidIfAlive(descendantPid);
      killPidIfAlive(unrelated.pid);
      await childResult;
      await unrelated;
    }
  });
});
