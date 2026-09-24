import type { PluginHostCleanupFailure } from "./host-hook-cleanup.types.js";

/** Instance disposal also observes host-hook errors; preserve their more specific attribution. */
export function appendPluginInstanceCleanupFailures(
  failures: PluginHostCleanupFailure[],
  pluginId: string,
  errors: readonly unknown[],
): void {
  for (const error of errors) {
    if (!failures.some((failure) => failure.pluginId === pluginId && failure.error === error)) {
      failures.push({ pluginId, hookId: "instance", error });
    }
  }
}
