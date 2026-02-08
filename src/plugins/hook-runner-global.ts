/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 */

import type { PluginRegistry } from "./registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createHookRunner, type HookRunner } from "./hooks.js";

const log = createSubsystemLogger("plugins");

// Use globalThis to share singleton across disparate bundles (e.g. gateway bundle vs agent runner bundle)
const GLOBAL_HOOK_RUNNER_KEY = Symbol.for("openclaw.globalHookRunner");
const GLOBAL_REGISTRY_KEY = Symbol.for("openclaw.globalRegistry");

type HookRunnerWithDebugId = HookRunner & { _debugId?: string };

type GlobalHookRunnerState = {
  [GLOBAL_HOOK_RUNNER_KEY]?: HookRunner | null;
  [GLOBAL_REGISTRY_KEY]?: PluginRegistry | null;
};

const globalHookRunnerState = globalThis as typeof globalThis & GlobalHookRunnerState;

export function initializeGlobalHookRunner(registry: PluginRegistry): void {
  // Prevent overwriting unless the existing registry is empty and the new one has hooks.
  const existingRunner = globalHookRunnerState[GLOBAL_HOOK_RUNNER_KEY];
  if (existingRunner) {
    const existingRegistry = globalHookRunnerState[GLOBAL_REGISTRY_KEY];
    const existingHooks = existingRegistry?.hooks.length ?? 0;
    const nextHooks = registry.hooks.length;
    if (existingHooks > 0 || nextHooks === 0) {
      const debugId = (existingRunner as HookRunnerWithDebugId)._debugId;
      log.warn(
        `[debug] HookRunner already initialized (ID=${debugId}). Ignoring re-initialization.`,
      );
      return;
    }
    log.warn(
      `[debug] HookRunner reinitialized with populated registry (prev hooks=0, next hooks=${nextHooks}).`,
    );
  }

  globalHookRunnerState[GLOBAL_REGISTRY_KEY] = registry;

  const runner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
  });

  // Assign a debug ID
  const debugId = `Runner_${Math.random().toString(36).slice(2, 6)}`;
  (runner as HookRunnerWithDebugId)._debugId = debugId;

  globalHookRunnerState[GLOBAL_HOOK_RUNNER_KEY] = runner;

  const hookCount = registry.hooks.length;
  // Always log initialization for debugging
  log.info(`[debug] HookRunner initialized. ID=${debugId}, hooks=${hookCount}`);
  if (hookCount > 0) {
    registry.hooks.forEach((h) =>
      log.info(`[debug] Registered hook: ${h.events.join(",")} by ${h.pluginId}`),
    );
  }
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return globalHookRunnerState[GLOBAL_HOOK_RUNNER_KEY] ?? null;
}

/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): PluginRegistry | null {
  return globalHookRunnerState[GLOBAL_REGISTRY_KEY] ?? null;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean {
  const runner = getGlobalHookRunner();
  return runner?.hasHooks(hookName) ?? false;
}

/**
 * Reset the global hook runner (for testing).
 */
export function resetGlobalHookRunner(): void {
  globalHookRunnerState[GLOBAL_HOOK_RUNNER_KEY] = null;
  globalHookRunnerState[GLOBAL_REGISTRY_KEY] = null;
}
