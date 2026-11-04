/**
 * Child-process output cleanup for commands whose descendants inherit pipes.
 */
import type { ChildProcess } from "node:child_process";

export const EXIT_STDIO_GRACE_MS = 100;
const EXIT_STDIO_MAX_DRAIN_MS = 1_000;

/** Native and broker exit notifications can precede output EOF. */
export function hasChildProcessExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/** Bound output draining after an authentic root exit, independently of the transport. */
export function createChildProcessOutputRelease(releaseOutput: () => void) {
  let idleTimer: NodeJS.Timeout | undefined;
  let releaseTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const cleanup = () => {
    disposed = true;
    clearTimeout(idleTimer);
    clearTimeout(releaseTimer);
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };
  const release = () => {
    cleanup();
    releaseOutput();
  };
  const scheduleRelease = () => {
    // Either timer may run before already-buffered pipe data on a loaded loop.
    // Defer to the next timers phase so both Node and Bun poll the pipes first.
    releaseTimer ??= setTimeout(release, 0);
    releaseTimer.unref();
  };
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    clearTimeout(releaseTimer);
    releaseTimer = undefined;
    idleTimer = setTimeout(scheduleRelease, EXIT_STDIO_GRACE_MS);
    idleTimer.unref();
  };
  const onData = () => {
    if (deadlineTimer) {
      armIdleTimer();
    }
  };
  const onExit = () => {
    if (disposed) {
      return;
    }
    deadlineTimer = setTimeout(() => {
      // Post-deadline data must not cancel release and extend the hard bound.
      deadlineTimer = undefined;
      scheduleRelease();
    }, EXIT_STDIO_MAX_DRAIN_MS);
    deadlineTimer.unref();
    armIdleTimer();
  };

  return { onData, onExit, dispose: cleanup };
}

/** Execa may retain pipes inherited by detached descendants after its direct child exits. */
export function releaseChildProcessOutputAfterExit(child: ChildProcess): () => void {
  const release = createChildProcessOutputRelease(() => {
    cleanup();
    child.stdout?.destroy();
    child.stderr?.destroy();
  });
  const { onData, onExit } = release;
  const cleanup = () => {
    release.dispose();
    child.removeListener("exit", onExit);
    child.stdout?.removeListener("data", onData);
    child.stderr?.removeListener("data", onData);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  // A command deadline can transfer output here after the root has already exited.
  if (hasChildProcessExited(child)) {
    onExit();
  } else {
    child.once("exit", onExit);
  }
  return cleanup;
}
