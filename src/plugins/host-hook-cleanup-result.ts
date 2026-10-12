import type {
  PluginHostCleanupFailure,
  PluginHostCleanupResult,
} from "./host-hook-cleanup.types.js";
import type { PluginInstanceDisposalResult } from "./plugin-instance.types.js";

/** Terminal retirement reports failures only after all admitted cleanup has settled. */
export function summarizePluginRetirementResults(
  results: readonly PromiseSettledResult<PluginHostCleanupResult>[],
  message: string,
): PluginHostCleanupResult {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, message);
  }
  const completed = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  return {
    cleanupCount: completed.reduce((count, result) => count + result.cleanupCount, 0),
    failures: completed.flatMap((result) => result.failures),
  };
}

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
