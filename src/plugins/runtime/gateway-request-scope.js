import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY = Symbol.for("openclaw.pluginRuntimeGatewayRequestScope");
const pluginRuntimeGatewayRequestScope = resolveGlobalSingleton(PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY, () => new AsyncLocalStorage());
/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export function withPluginRuntimeGatewayRequestScope(scope, run) {
    return pluginRuntimeGatewayRequestScope.run(scope, run);
}
/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginIdScope(pluginId, run) {
    const current = pluginRuntimeGatewayRequestScope.getStore();
    const scoped = current
        ? { ...current, pluginId }
        : {
            pluginId,
            isWebchatConnect: () => false,
        };
    return pluginRuntimeGatewayRequestScope.run(scoped, run);
}
/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export function getPluginRuntimeGatewayRequestScope() {
    return pluginRuntimeGatewayRequestScope.getStore();
}
