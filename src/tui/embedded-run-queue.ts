// Queued-run lifecycle helpers for the embedded TUI backend: readiness latches
// and shutdown/handoff waits for same-session runs queued behind an active one.
import { resolveLocalRunShutdownGraceMs } from "./local-run-shutdown.js";

/** Narrow view of a queued run; the backend's full run state satisfies it structurally. */
type QueuedRunLifecycle = {
  run: { queuedRunReady: Promise<void>; finishing: boolean; lifecycleEnded: boolean };
  promise: Promise<void>;
};

export function createQueuedRunReadiness() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  if (!resolve) {
    throw new Error("Expected queue readiness resolver to be initialized");
  }
  const resolveReady = resolve;
  let settled = false;
  return {
    promise,
    markReady: () => {
      if (settled) {
        return;
      }
      settled = true;
      resolveReady();
    },
  };
}

export async function waitForLocalRunShutdown(promises: Promise<void>[]): Promise<boolean> {
  if (promises.length === 0) {
    return true;
  }
  const timeoutMs = resolveLocalRunShutdownGraceMs();
  if (timeoutMs <= 0) {
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  await Promise.race([
    Promise.allSettled(promises).then(() => {
      completed = true;
    }),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return completed;
}

export async function waitForQueuedLocalRun(
  previousRun: QueuedRunLifecycle,
  runId: string,
): Promise<void> {
  await previousRun.run.queuedRunReady;
  if (!previousRun.run.finishing && !previousRun.run.lifecycleEnded) {
    await previousRun.promise;
    return;
  }
  const timeoutMs = resolveLocalRunShutdownGraceMs();
  if (timeoutMs <= 0) {
    throw new Error(
      `timed out waiting for previous local run to finish post-turn maintenance for ${runId}`,
    );
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previousRun.promise,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for previous local run to finish post-turn maintenance for ${runId}`,
            ),
          );
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
