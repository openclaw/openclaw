/**
 * Child-process compatibility helpers for agent utilities.
 *
 * Wraps platform-specific spawn behavior and safe close handling for inherited stdio.
 */
import type { ChildProcess } from "node:child_process";

/**
 * Release data listeners from a child process and its stdio streams after settle.
 *
 * After a promise settles on child lifecycle events the process object and its
 * pipe buffers remain reachable through leftover data listeners, delaying GC.
 * Call this from settle paths so accumulated stdout/stderr buffers are eligible
 * for collection immediately rather than on the next tick.
 *
 * Stream error listeners are intentionally preserved — Node.js throws unhandled
 * "error" events when no listener is attached, and late stream errors after
 * settle must be swallowed rather than surfaced as crashes.
 */
export function releaseChildProcessListeners(child: ChildProcess): void {
  // Remove only data listeners from stdout/stderr (the heavy ones that hold
  // buffer references through closures). Error listeners stay to swallow late
  // stream errors without crashing.
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  // stdin has no data listener; it only carries an error guard. Keep that too.
  child.stdin?.removeAllListeners("data");
  // Child process lifecycle events (error, close, exit) are safe to remove
  // entirely — the promise already settled.
  child.removeAllListeners();
}

const EXIT_STDIO_GRACE_MS = 100;
const EXIT_STDIO_MAX_DRAIN_MS = 1_000;

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A detached descendant may keep stdout/stderr open after the child exits. Wait
 * until those pipes are idle, re-arming the grace timer for every late chunk, so
 * active output drains without hanging forever on an inherited handle.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let postExitDeadlineTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      if (postExitDeadlineTimer) {
        clearTimeout(postExitDeadlineTimer);
        postExitDeadlineTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.stdout?.removeListener("error", onStreamError);
      child.stderr?.removeListener("error", onStreamError);
    };

    const finalize = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) {
        return;
      }
      if (stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };

    const armIdleTimer = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
      }
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      if (exited && !settled) {
        armIdleTimer();
      }
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };

    const onStreamError = () => {
      // Stream read errors on stdout/stderr are non-fatal; the child process
      // error/exit/close handlers report the real outcome.
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) {
        // Drain finite descendant tails, but never let a chatty inherited pipe
        // keep an already-exited command alive indefinitely.
        postExitDeadlineTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_MAX_DRAIN_MS);
        armIdleTimer();
      }
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("error", onStreamError);
    child.stderr?.on("error", onStreamError);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}
