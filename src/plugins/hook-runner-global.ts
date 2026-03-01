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

/**
 * Use globalThis to store the hook runner and registry.
 * This ensures all bundled chunks share the same instance,
 * even when code is split across multiple entry points.
 */
const GLOBAL_KEY = "openclaw:pluginHookRunner";
const GLOBAL_REGISTRY_KEY = "openclaw:pluginRegistry";

function getStoredHookRunner(): HookRunner | null {
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as HookRunner | null;
}

function setStoredHookRunner(runner: HookRunner | null): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = runner;
}

function getStoredRegistry(): PluginRegistry | null {
  return (globalThis as Record<string, unknown>)[GLOBAL_REGISTRY_KEY] as PluginRegistry | null;
}

function setStoredRegistry(registry: PluginRegistry | null): void {
  (globalThis as Record<string, unknown>)[GLOBAL_REGISTRY_KEY] = registry;
}

let globalHookRunner: HookRunner | null = null;
let globalRegistry: PluginRegistry | null = null;

/**
 * Initialize the global hook runner with a plugin registry.
 * Called once when plugins are loaded during gateway startup.
 */
export function initializeGlobalHookRunner(registry: PluginRegistry): void {
  globalRegistry = registry;
  globalHookRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
  });

  // Also store in globalThis for cross-chunk access in bundled builds
  setStoredRegistry(registry);
  setStoredHookRunner(globalHookRunner);

  const hookCount = registry.typedHooks.length;
  if (hookCount > 0) {
    log.info(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  // First try the module-level variable (works in non-bundled builds)
  if (globalHookRunner) {
    return globalHookRunner;
  }
  // Fall back to globalThis (required for bundled builds with code splitting)
  return getStoredHookRunner();
}

/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): PluginRegistry | null {
  // First try the module-level variable (works in non-bundled builds)
  if (globalRegistry) {
    return globalRegistry;
  }
  // Fall back to globalThis (required for bundled builds with code splitting)
  return getStoredRegistry();
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
  setStoredHookRunner(null);
  setStoredRegistry(null);
}
