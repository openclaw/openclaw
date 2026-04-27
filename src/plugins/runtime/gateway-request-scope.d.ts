import type { GatewayRequestContext, GatewayRequestOptions } from "../../gateway/server-methods/types.js";
export type PluginRuntimeGatewayRequestScope = {
    context?: GatewayRequestContext;
    client?: GatewayRequestOptions["client"];
    isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
    pluginId?: string;
};
/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export declare function withPluginRuntimeGatewayRequestScope<T>(scope: PluginRuntimeGatewayRequestScope, run: () => T): T;
/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export declare function withPluginRuntimePluginIdScope<T>(pluginId: string, run: () => T): T;
/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export declare function getPluginRuntimeGatewayRequestScope(): PluginRuntimeGatewayRequestScope | undefined;
