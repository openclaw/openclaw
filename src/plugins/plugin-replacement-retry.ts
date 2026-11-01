// Host callers resolve a plugin target once more after a reload that refused it.
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";

/** True when a reload refused a fresh call and the caller may report a retryable outage. */
export function isPluginReloadingError(error: unknown): error is PluginInstanceUnavailableError {
  return error instanceof PluginInstanceUnavailableError && error.replacement !== undefined;
}

/**
 * Runs a fresh host call into plugin code. When a pending reload refuses its
 * admission, waits for that reload to settle and runs it once more. `run` must
 * resolve its target from the current registry on each call, so the second
 * attempt reaches the published generation, or the restored one after rollback.
 */
export async function retryAfterPluginReplacement<T>(run: () => T | PromiseLike<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isPluginReloadingError(error)) {
      throw error;
    }
    await error.replacement;
    return await run();
  }
}
