/**
 * Per-subsystem timeout applied during gateway shutdown.  Prevents a single
 * hung stop/close call from consuming the entire SHUTDOWN_TIMEOUT_MS budget
 * defined in run-loop.ts (25 s).  If a subsystem does not finish within this
 * window the close handler moves on to the next step so remaining subsystems
 * still get a chance to clean up.
 */
export const SUBSYSTEM_STOP_TIMEOUT_MS = 5_000;

export interface ShutdownLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Race a promise against a timeout.  Resolves when either the promise settles
 * or the deadline fires — whichever comes first. The losing branch is left
 * dangling; callers that pass promises which may reject after timeout must
 * attach their own rejection observer.
 */
export async function raceTimeout(
  promise: Promise<void>,
  ms: number,
  label: string,
  log?: ShutdownLogger,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log?.warn(
        { subsystem: label, timeoutMs: ms },
        `shutdown: ${label} did not stop within ${ms}ms, continuing`,
      );
      resolve();
    }, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
