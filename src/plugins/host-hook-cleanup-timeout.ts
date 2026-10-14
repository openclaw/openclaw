import { trackAsyncWork } from "../shared/async-work-scope.js";
import { settlesWithin } from "../shared/settle-within.js";

/** Max time allowed for plugin host cleanup hooks before failing shutdown. */
const PLUGIN_HOST_CLEANUP_TIMEOUT_MS = 5_000;

export class PluginHostCleanupTimeoutError extends Error {}

/** Runs plugin host cleanup with a bounded timeout and clears the timer afterward. */
export async function withPluginHostCleanupTimeout<T>(
  hookId: string,
  cleanup: () => T | Promise<T>,
  timeoutMs = PLUGIN_HOST_CLEANUP_TIMEOUT_MS,
): Promise<T> {
  const pending = trackAsyncWork(() => Promise.resolve().then(cleanup));
  if (!(await settlesWithin(pending, timeoutMs))) {
    throw new PluginHostCleanupTimeoutError(`plugin host cleanup timed out: ${hookId}`);
  }
  return await pending;
}
