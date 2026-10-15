import {
  getPluginRuntimeGeneration,
  PluginRuntimeApplicationError,
  type PluginRuntimeApplication,
} from "../plugins/lifecycle.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import { PluginAdmittedWorkTimeoutError } from "./server-plugin-reload-cleanup.js";
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

/**
 * Retain a failed automatic drain until its generation or pending settings settle,
 * and schedule the replacement again once the failed plugins' work settles.
 */
export function createConfigPluginDrainTracker(params: {
  signal: AbortSignal;
  onWorkSettled: () => void;
}) {
  let failure:
    | {
        error: PluginRuntimeApplicationError;
        paths: readonly string[];
        observation: AbortController;
        retriesWhenIdle: boolean;
        reported: boolean;
      }
    | undefined;
  const clear = () => {
    failure?.observation.abort();
    failure = undefined;
  };
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
        clear();
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
        clear();
        const timeout =
          error.cause instanceof PluginAdmittedWorkTimeoutError ? error.cause : undefined;
        const current = {
          error,
          paths: plan.reloadPluginPaths ?? [],
          observation: new AbortController(),
          retriesWhenIdle: timeout !== undefined,
          reported: false,
        };
        failure = current;
        if (!timeout) {
          return;
        }
        // The rolled-back generation keeps serving and accepting work. Retry a timed-out
        // drain when it would pass immediately; other drain failures need an operator.
        const signal = AbortSignal.any([params.signal, current.observation.signal]);
        void Promise.all(timeout.instances.map((instance) => instance.waitForIdle(signal))).then(
          () => {
            if (failure === current) {
              clear();
              params.onWorkSettled();
            }
          },
          () => {},
        );
      }
    },
    applied(plan?: GatewayReloadPlan, runtime?: PluginRuntimeApplication) {
      // Clear reverted settings only after the candidate applies, including unrelated plugin edits.
      if (!plan?.reloadPlugins || runtime || !hasPendingFailure(plan)) {
        clear();
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
    /** Whether the deferring failure clears itself once its timed-out work settles. */
    retriesWhenIdle() {
      return failure?.retriesWhenIdle ?? false;
    },
  };
}
