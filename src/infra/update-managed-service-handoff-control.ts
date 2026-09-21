import type { ChildProcess } from "node:child_process";
import { forceKillChildProcessTree } from "../process/child-process-tree.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";

// The private admission pipe must not change the installed CLI's stdin lifetime.
export const HANDOFF_COMMAND_RUNNER_SCRIPT = String.raw`
const gateFs = process.getBuiltinModule("fs");
const gate = Buffer.alloc(2);
try {
  if (gateFs.readSync(4, gate) !== 2 || gate.toString() !== "go")
    throw new Error("Managed handoff admission was refused");
} finally { gateFs.closeSync(4); }
`;

export const HANDOFF_EXEC_RUNNER_SCRIPT = String.raw`
${HANDOFF_COMMAND_RUNNER_SCRIPT}
const { spawn } = require("node:child_process");
const argv = JSON.parse(process.argv[1]);
if (process.platform !== "win32" && typeof process.execve === "function")
  process.execve(argv[0], argv, process.env);
const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: "inherit" });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code, signal) => {
  process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
});
`;

export const HANDOFF_NOTICE_MARKER = "before-park\n";

export type HandoffChild = ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
};

export function unrefHandoffPipe(pipe: HandoffChild["stdin"] | HandoffChild["stdout"]): void {
  if ("unref" in pipe && typeof pipe.unref === "function") {
    pipe.unref();
  }
}
export function waitForHandoffResponse(
  child: HandoffChild,
  timeoutMs: number,
  command?: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const output = child.stdout;
    const exitEvent = command === "closed" ? "close" : "exit";
    let settled = false;
    let buffered = "";
    // An already-expired deadline can settle before a timer exists.
    let cancelTimeout = () => {};
    const finish = (result: string | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cancelTimeout();
      child.removeListener("error", finish);
      child.removeListener(exitEvent, onExit);
      output.removeListener("data", onData);
      output.removeListener("error", onOutputError);
      child.stdin.removeListener("error", finish).removeListener("close", onInputClose);
      if (result instanceof Error) {
        if (!command) {
          output.destroy();
        }
        reject(result);
      } else {
        resolve(result);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `managed update handoff exited before ${command ? "responding" : "signaling readiness"} (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    };
    const onOutputError = (err: Error) => {
      if (!command && child.pid) {
        // A loaded helper is armed even when its readiness marker was lost.
        forceKillChildProcessTree(child);
      }
      finish(err);
    };
    const onInputClose = () => {
      if (command !== "closed") {
        finish(new Error("managed update handoff control input closed"));
      }
    };
    const onData = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-1024);
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline + 1);
        buffered = buffered.slice(newline + 1);
        if (line !== HANDOFF_NOTICE_MARKER) {
          finish(line.slice(0, -1));
          return;
        }
      }
    };
    // The canonical updater owns activation/finalization budgets. Once closed,
    // the parent joins its helper instead of inventing a shorter shutdown timer.
    if (command !== "closed") {
      cancelTimeout = scheduleAbsoluteDeadline(Date.now() + timeoutMs, () => {
        const phase = command ? "respond" : "signal readiness";
        onOutputError(
          new Error(`managed update handoff did not ${phase} within ${timeoutMs / 1000} seconds`),
        );
      });
    }
    if (settled) {
      return;
    }

    child.once("error", finish).once(exitEvent, onExit);
    output.once("error", onOutputError).on("data", onData);
    child.stdin.once("error", finish).once("close", onInputClose);
    if (command) {
      child.stdin.write(`${command}\n`, (error) => {
        if (error) {
          finish(error);
        }
      });
    }
  });
}
