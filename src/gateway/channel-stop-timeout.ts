import { settlesWithin } from "../shared/settle-within.js";

export async function waitForChannelStopGracefully(
  task: Promise<unknown> | undefined,
  timeoutMs: number,
) {
  if (!task) {
    return true;
  }
  // Channel stop hooks can hang during provider disconnects. Bound the wait so
  // restart/reload can continue after aborting the runtime.
  return await settlesWithin(
    task.catch(() => undefined),
    timeoutMs,
  );
}
