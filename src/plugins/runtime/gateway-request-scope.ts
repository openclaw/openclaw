import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";

export type PluginRuntimeGatewayRequestScope = {
  context: GatewayRequestContext;
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
};

const pluginRuntimeGatewayRequestScope = new AsyncLocalStorage<PluginRuntimeGatewayRequestScope>();

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
