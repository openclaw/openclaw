/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createHookRunner } from "./hooks.js";
const log = createSubsystemLogger("plugins");
let globalHookRunner = null;
let globalRegistry = null;
/**
 * Initialize the global hook runner with a plugin registry.
 * Called once when plugins are loaded during gateway startup.
 */
export function initializeGlobalHookRunner(registry) {
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
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner() {
    return globalHookRunner;
}
/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry() {
    return globalRegistry;
}
/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName) {
    return globalHookRunner?.hasHooks(hookName) ?? false;
}
export async function runGlobalGatewayStopSafely(params) {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("gateway_stop")) {
        return;
    }
    try {
        await hookRunner.runGatewayStop(params.event, params.ctx);
    }
    catch (err) {
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
export function resetGlobalHookRunner() {
    globalHookRunner = null;
    globalRegistry = null;
}
