import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  attachGatewayWsConnectionHandler,
  type AttachGatewayWsConnectionHandlerParams,
} from "./server/ws-connection.js";

type GatewayWsRuntimeParams = Omit<
  AttachGatewayWsConnectionHandlerParams,
  "buildRequestContext" | "refreshHealthSnapshot"
> & {
  context: GatewayRequestContext;
};

/** Wires websocket connection handling to the already-built live Gateway request context. */
export function attachGatewayWsHandlers(params: GatewayWsRuntimeParams) {
  attachGatewayWsConnectionHandler({
    wss: params.wss,
    clients: params.clients,
    preauthConnectionBudget: params.preauthConnectionBudget,
    port: params.port,
    gatewayHost: params.gatewayHost,
    pluginSurfaceScheme: params.pluginSurfaceScheme,
    getPluginNodeCapabilities: params.getPluginNodeCapabilities,
    resolvedAuth: params.resolvedAuth,
    getResolvedAuth: params.getResolvedAuth,
    getRequiredSharedGatewaySessionGeneration: params.getRequiredSharedGatewaySessionGeneration,
    rateLimiter: params.rateLimiter,
    browserRateLimiter: params.browserRateLimiter,
    preauthHandshakeTimeoutMs: params.preauthHandshakeTimeoutMs,
    isStartupPending: params.isStartupPending,
    gatewayMethods: params.gatewayMethods,
    events: params.events,
    refreshHealthSnapshot: params.context.refreshHealthSnapshot,
    logGateway: params.logGateway,
    logHealth: params.logHealth,
    logWsControl: params.logWsControl,
    extraHandlers: params.extraHandlers,
    getMethodRegistry: params.getMethodRegistry,
    broadcast: params.broadcast,
    // Keep a single context object per server runtime; hot-reloaded fields inside
    // the context stay live without rebuilding websocket handler closures.
    buildRequestContext: () => params.context,
  });
}
