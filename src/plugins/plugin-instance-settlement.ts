import { toErrorObject } from "../infra/errors.js";

/** Observers never revoke admitted work; cancellation removes only their waiter. */
export async function waitForPluginInstanceSettlement(
  pluginId: string,
  waiters: Set<() => void>,
  settled: () => boolean,
  signal: AbortSignal | number,
): Promise<void> {
  if (typeof signal === "number") {
    const timeoutMs = signal;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new Error(`Plugin ${pluginId} still has active calls after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      await waitForPluginInstanceSettlement(pluginId, waiters, settled, deadline.signal);
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  signal.throwIfAborted();
  if (settled()) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      waiters.delete(wake);
      signal.removeEventListener("abort", abort);
    };
    const wake = () => {
      if (settled()) {
        cleanup();
        resolve();
      }
    };
    const abort = () => {
      cleanup();
      reject(toErrorObject(signal.reason, `Plugin ${pluginId} work drain aborted`));
    };
    waiters.add(wake);
    signal.addEventListener("abort", abort, { once: true });
  });
}
