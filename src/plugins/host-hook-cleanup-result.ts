import type { PluginHostCleanupFailure } from "./host-hook-cleanup.types.js";
import type { PluginInstanceDisposalResult } from "./plugin-instance.types.js";

/** Merge raw instance outcomes without duplicating their existing host or instance report. */
export function appendPluginInstanceCleanupFailures(
  failures: PluginHostCleanupFailure[],
  pluginId: string,
  result: PluginInstanceDisposalResult,
): void {
  for (const error of result.errors) {
    if (
      failures.some(
        (failure) =>
          failure.pluginId === pluginId &&
          failure.error === error &&
          (failure.hookId === "instance" || result.hostCleanupErrors?.includes(error)),
      )
    ) {
      continue;
    }
    failures.push({ pluginId, hookId: "instance", error });
  }
}
