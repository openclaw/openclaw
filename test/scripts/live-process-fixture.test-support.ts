import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The wrappers join their groups; an orphan PID can outlive that receipt until reaped.
export async function waitForProcessExit(pid: number, signal: AbortSignal) {
  try {
    while (isProcessAlive(pid)) {
      await delay(5, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`timed out waiting for process ${pid} to exit`, { cause: error });
    }
    throw error;
  }
}

export function waitForClose(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}
