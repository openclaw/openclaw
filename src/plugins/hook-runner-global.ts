/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 *
 * Reinitialization is deferred while hook executions are in-flight so that
 * hooks (e.g. message_sending) are never skipped due to a mid-execution
 * registry swap.  See #42644.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { createHookRunner, type HookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookGatewayContext, PluginHookGatewayStopEvent } from "./types.js";

const log = createSubsystemLogger("plugins");

/**
 * Maximum time (ms) to wait for in-flight hooks to drain before force-flushing
 * a deferred registry swap.  Prevents permanent starvation when a guarded hook
 * never resolves.
 */
export const DEFER_TIMEOUT_MS = 30_000;

type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: PluginRegistry | null;
  /** Number of hook executions currently in progress. */
  inFlightCount: number;
  /** Registry waiting to be applied once in-flight hooks drain. */
  pendingInit: PluginRegistry | null;
  /** Handle for the starvation-prevention timeout, if one is scheduled. */
  pendingInitTimeout: ReturnType<typeof setTimeout> | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

function getHookRunnerGlobalState(): HookRunnerGlobalState {
  const globalStore = globalThis as typeof globalThis & {
    [hookRunnerGlobalStateKey]?: HookRunnerGlobalState;
  };
  return (globalStore[hookRunnerGlobalStateKey] ??= {
    hookRunner: null,
    registry: null,
    inFlightCount: 0,
    pendingInit: null,
    pendingInitTimeout: null,
  });
}

function applyHookRunnerInit(state: HookRunnerGlobalState, registry: PluginRegistry): void {
  const newRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
  });

  // Atomic swap: both fields are updated together so consumers never
  // observe a partially-initialized state.
  state.hookRunner = newRunner;
  state.registry = registry;

  const hookCount = registry.hooks.length;
  if (hookCount > 0) {
    log.info(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

/**
 * Initialize the global hook runner with a plugin registry.
 *
 * If hook executions are currently in-flight the swap is deferred until all
 * of them complete — the old runner stays active so no hooks are skipped.
 */
export function initializeGlobalHookRunner(registry: PluginRegistry): void {
  const state = getHookRunnerGlobalState();

  if (state.inFlightCount > 0) {
    // Keep only the latest pending registry (newer reload wins).
    state.pendingInit = registry;

    // Reset the starvation-prevention timer so it always counts from the
    // most recent defer request.
    if (state.pendingInitTimeout) {
      clearTimeout(state.pendingInitTimeout);
    }
    state.pendingInitTimeout = setTimeout(() => {
      if (state.pendingInit) {
        log.warn(
          `hook runner reinitialization forced after timeout — ${state.inFlightCount} hook(s) still in-flight`,
        );
        const pendingRegistry = state.pendingInit;
        state.pendingInit = null;
        state.pendingInitTimeout = null;
        try {
          applyHookRunnerInit(state, pendingRegistry);
        } catch (err) {
          log.error(`failed to force-apply deferred hook runner init: ${String(err)}`);
        }
      }
    }, DEFER_TIMEOUT_MS);

    log.debug(
      `hook runner reinitialization deferred — ${state.inFlightCount} hook(s) still in-flight`,
    );
    return;
  }

  applyHookRunnerInit(state, registry);
}

/**
 * Execute an async callback while guarding the hook runner against
 * reinitialization.  Any call to {@link initializeGlobalHookRunner} that
 * occurs while `fn` is executing will be deferred until all guarded
 * executions have finished.
 *
 * Returns the result of `fn`.
 */
export async function withGlobalHookExecution<T>(fn: () => Promise<T>): Promise<T> {
  const state = getHookRunnerGlobalState();
  state.inFlightCount++;
  try {
    return await fn();
  } finally {
    state.inFlightCount--;
    if (state.inFlightCount === 0 && state.pendingInit) {
      const registry = state.pendingInit;
      state.pendingInit = null;
      if (state.pendingInitTimeout) {
        clearTimeout(state.pendingInitTimeout);
        state.pendingInitTimeout = null;
      }
      try {
        applyHookRunnerInit(state, registry);
      } catch (err) {
        log.error(`failed to apply deferred hook runner init: ${String(err)}`);
        // Restore so the next execution drain can retry.
        state.pendingInit = registry;
      }
    }
  }
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return getHookRunnerGlobalState().hookRunner;
}

/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): PluginRegistry | null {
  return getHookRunnerGlobalState().registry;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean {
  return getHookRunnerGlobalState().hookRunner?.hasHooks(hookName) ?? false;
}

export async function runGlobalGatewayStopSafely(params: {
  event: PluginHookGatewayStopEvent;
  ctx: PluginHookGatewayContext;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("gateway_stop")) {
    return;
  }
  try {
    await hookRunner.runGatewayStop(params.event, params.ctx);
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    log.warn(`gateway_stop hook failed: ${String(err)}`);
  }
}

/**
 * Reset the global hook runner (for testing).
 */
export function resetGlobalHookRunner(): void {
  const state = getHookRunnerGlobalState();
  if (state.pendingInitTimeout) {
    clearTimeout(state.pendingInitTimeout);
  }
  state.hookRunner = null;
  state.registry = null;
  state.inFlightCount = 0;
  state.pendingInit = null;
  state.pendingInitTimeout = null;
}
