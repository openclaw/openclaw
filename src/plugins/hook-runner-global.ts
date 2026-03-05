/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { createHookRunner, type HookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookGatewayContext, PluginHookGatewayStopEvent } from "./types.js";

const log = createSubsystemLogger("plugins");

let globalHookRunner: HookRunner | null = null;
let globalRegistry: PluginRegistry | null = null;

/**
 * Initialize the global hook runner with a plugin registry.
 *
 * Only the FIRST call sets up the runner. Subsequent calls from
 * `loadOpenClawPlugins` (e.g. per-agent tool resolution with a different
 * workspaceDir) are no-ops.  This prevents a cache-miss registry — which
 * lacks core hooks like task-enforcer — from replacing the runner that was
 * set up during gateway startup.
 *
 * Use `resetGlobalHookRunner()` (tests) or `forceReinitializeGlobalHookRunner()`
 * to explicitly replace the runner when needed.
 */
export function initializeGlobalHookRunner(registry: PluginRegistry): void {
  if (globalHookRunner) {
    return;
  }
  globalRegistry = registry;
  globalHookRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
  });

  const hookCount = registry.hooks.length;
  if (hookCount > 0) {
    log.info(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

/**
 * Force-replace the global hook runner with a new registry.
 * Use only for explicit config reloads — NOT from loadOpenClawPlugins().
 */
export function forceReinitializeGlobalHookRunner(registry: PluginRegistry): void {
  globalRegistry = registry;
  globalHookRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
  });
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return globalHookRunner;
}

/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): PluginRegistry | null {
  return globalRegistry;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean {
  return globalHookRunner?.hasHooks(hookName) ?? false;
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
  globalHookRunner = null;
  globalRegistry = null;
}
