import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";

export type PluginRuntimeGatewayRequestScope = {
  context: GatewayRequestContext;
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
};

const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGatewayRequestScope",
);

const pluginRuntimeGatewayRequestScope = (() => {
  const globalState = globalThis as typeof globalThis & {
    [PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY]?: AsyncLocalStorage<PluginRuntimeGatewayRequestScope>;
  };
  const existing = globalState[PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY];
  if (existing) {
    return existing;
  }
  const created = new AsyncLocalStorage<PluginRuntimeGatewayRequestScope>();
  globalState[PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY] = created;
  return created;
})();

/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
): T {
  return pluginRuntimeGatewayRequestScope.run(scope, run);
}

/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export function getPluginRuntimeGatewayRequestScope():
  | PluginRuntimeGatewayRequestScope
  | undefined {
  return pluginRuntimeGatewayRequestScope.getStore();
}
