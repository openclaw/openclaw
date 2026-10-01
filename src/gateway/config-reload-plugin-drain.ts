import {
  getPluginRuntimeGeneration,
  PluginRuntimeApplicationError,
  type PluginRuntimeApplication,
} from "../plugins/lifecycle.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

export function isConfigReloadSuperseded(error: unknown): boolean {
  // Only completed rollback preserves the direct cause. Cleanup failures and
  // published replacements must settle instead of transferring the write.
  const cause =
    error instanceof PluginRuntimeApplicationError && !error.details.committed
      ? error.cause
      : error;
  return cause instanceof GatewayConfigReloadSupersededError;
}

/** Retain a failed automatic drain until its generation or pending settings settle. */
export function createConfigPluginDrainTracker() {
  let failure:
    | { error: PluginRuntimeApplicationError; paths: readonly string[]; reported: boolean }
    | undefined;
  const hasPendingFailure = (plan?: GatewayReloadPlan) =>
    failure?.paths.some((failedPath) =>
      plan?.changedPaths.some(
        (path) =>
          path === failedPath ||
          path.startsWith(`${failedPath}.`) ||
          failedPath.startsWith(`${path}.`),
      ),
    ) ?? false;
  return {
    assertCanApply(plan: GatewayReloadPlan) {
      if (failure && failure.error.details.generation !== getPluginRuntimeGeneration()) {
        failure = undefined;
      }
      if (
        plan.reloadPlugins &&
        failure &&
        !plan.pluginLifecycle?.waitForDrain &&
        hasPendingFailure(plan)
      ) {
        // Publishing this candidate would expose plugin settings whose replacement never committed.
        throw failure.error;
      }
    },
    recordFailure(plan: GatewayReloadPlan, error: unknown) {
      if (
        !plan.pluginLifecycle &&
        error instanceof PluginRuntimeApplicationError &&
        error.details.phase === "drain" &&
        !error.details.committed &&
        !isConfigReloadSuperseded(error)
      ) {
        failure = { error, paths: plan.reloadPluginPaths ?? [], reported: false };
      }
    },
    applied(plan?: GatewayReloadPlan, runtime?: PluginRuntimeApplication) {
      // Clear reverted settings only after the candidate applies, including unrelated plugin edits.
      if (!plan?.reloadPlugins || runtime || !hasPendingFailure(plan)) {
        failure = undefined;
      }
    },
    shouldReport(error: unknown) {
      if (!failure || error !== failure.error) {
        return true;
      }
      const report = !failure.reported;
      failure.reported = true;
      return report;
    },
  };
}
