import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  getPluginRuntimeGeneration,
  PluginRuntimeApplicationError,
  type PluginRuntimeApplication,
} from "../plugins/lifecycle.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import {
  PluginAdmittedWorkTimeoutError,
  PluginReloadDeferredError,
} from "./server-plugin-reload-cleanup.js";
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
        error: PluginRuntimeApplicationError | PluginReloadDeferredError;
        generation: number;
        paths: readonly string[];
        observation: AbortController;
        retriesWhenIdle: boolean;
        observing: boolean;
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
    clear,
    supersedeDeferred() {
      if (failure?.error instanceof PluginReloadDeferredError) {
        clear();
      }
    },
    recordDeferred(plan: GatewayReloadPlan, error: PluginReloadDeferredError) {
      if (failure?.error === error) {
        return;
      }
      clear();
      failure = {
        error,
        generation: getPluginRuntimeGeneration(),
        paths: plan.reloadPluginPaths ?? [],
        observation: new AbortController(),
        retriesWhenIdle: true,
        observing: false,
        reported: false,
      };
    },
    assertCanApply(plan: GatewayReloadPlan) {
      if (failure && failure.generation !== getPluginRuntimeGeneration()) {
        clear();
      }
      if (
        plan.reloadPlugins &&
        failure &&
        !plan.pluginLifecycle?.waitForDrain &&
        !(plan.pluginLifecycle && failure.error instanceof PluginReloadDeferredError) &&
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
          generation: error.details.generation,
          paths: plan.reloadPluginPaths ?? [],
          observation: new AbortController(),
          retriesWhenIdle: timeout !== undefined,
          observing: false,
          reported: false,
        };
        failure = current;
      }
    },
    observeAfterReceipt() {
      const current = failure;
      const deferred =
        current?.error instanceof PluginReloadDeferredError ? current.error : current?.error.cause;
      if (
        !current ||
        current.observing ||
        !(
          deferred instanceof PluginAdmittedWorkTimeoutError ||
          deferred instanceof PluginReloadDeferredError
        )
      ) {
        return;
      }
      current.observing = true;
      // Only exact handles and settlement facts survive the saved write receipt.
      const signal = AbortSignal.any([params.signal, current.observation.signal]);
      void Promise.all([
        ...deferred.instances.map((instance) => instance.waitForIdle(signal)),
        ...(deferred instanceof PluginReloadDeferredError && deferred.priorCleanup
          ? [
              racePromiseWithAbortSignal(
                // A failed cleanup is also settled. Fresh admission reports its
                // owner-held failure instead of leaving a saved write waiting forever.
                deferred.priorCleanup.then(
                  () => undefined,
                  () => undefined,
                ),
                signal,
              ),
            ]
          : []),
      ]).then(
        () => {
          if (failure === current) {
            clear();
            params.onWorkSettled();
          }
        },
        () => {},
      );
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
