import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import type { GatewayHttpTransport } from "./server-transport-bridge.js";
import type { GatewayConnectionOptions } from "./server/connection.js";

export async function attachGatewayStartupConnections(params: {
  kernelRuntime: GatewayKernelRuntime & GatewayHttpTransport;
  port: number;
  bootId: string;
  log: GatewayConnectionOptions["logGateway"];
  logHealth: GatewayConnectionOptions["logHealth"];
  logWsControl: GatewayConnectionOptions["logWsControl"];
}) {
  const { kernelRuntime: runtime, port, bootId, log, logHealth, logWsControl } = params;
  const { startupTrace, workerEnvironmentService, preauthConnectionBudget, gatewayRequestContext } =
    runtime;
  const { attachGatewayWsConnectionHandler } = await startupTrace.measure(
    "gateway.ws-imports",
    () => import("./server/ws-connection.js"),
  );
  const { createGatewayOperatorHttpRuntime } = await startupTrace.measure(
    "gateway.operator-http-imports",
    () => import("./operator-http.js"),
  );
  const connectionOptions: GatewayConnectionOptions = {
    clients: runtime.clients,
    connectionWork: runtime.connectionWork,
    bootId,
    getPluginNodeCapabilities: runtime.getPluginNodeCapabilities,
    getResolvedAuth: runtime.getResolvedAuth,
    getRequiredSharedGatewaySessionGeneration: runtime.sharedGatewaySessionGenerationState.reader,
    rateLimiter: runtime.authRateLimiter,
    browserRateLimiter: runtime.browserAuthRateLimiter,
    nodeReapprovalCoordinator: runtime.nodeReapprovalCoordinator,
    isStartupPending: runtime.isGatewayStartupPending,
    isPendingWorkerNodeSetup: workerEnvironmentService?.hasPendingNodeEnrollmentSetup,
    admitsNodeSetupCompletion: workerEnvironmentService?.admitsNodeSetupCompletion,
    gatewayMethods: runtime.runtimeState.gatewayMethods,
    events: GATEWAY_EVENTS,
    logGateway: log,
    logHealth,
    logWsControl,
    extraHandlers: runtime.attachedGatewayExtraHandlers,
    getMethodRegistry: () => runtime.getAttachedGatewayMethodRegistry(),
    broadcast: runtime.broadcast,
    refreshHealthSnapshot: gatewayRequestContext.refreshHealthSnapshot,
    buildRequestContext: () => gatewayRequestContext,
  };
  await startupTrace.measure("gateway.ws-attach", () =>
    attachGatewayWsConnectionHandler({
      ...connectionOptions,
      wss: runtime.wss,
      preauthConnectionBudget,
      port,
      gatewayHost: runtime.bindHost ?? undefined,
      pluginSurfaceScheme: runtime.gatewayTls.enabled ? "https" : "http",
      ...(workerEnvironmentService ? { workerConnectionService: workerEnvironmentService } : {}),
    }),
  );
  const operatorHttp = createGatewayOperatorHttpRuntime({
    ...connectionOptions,
    basePath: runtime.controlUiBasePath,
    preauthConnectionBudget,
  });
  runtime.operatorHttpRequestHandler.current = operatorHttp.handleRequest;
  // Unpolled handshake delivery owns tracked work; retire it before the drain.
  runtime.registerConnectionDependentSidecars({ stop: operatorHttp.close });
}
