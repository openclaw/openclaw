// Physical WebSocket ingress adapts into the shared Gateway connection owner.
import type { WebSocketServer } from "ws";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/index.js";
import { touchPresence } from "../../infra/system-presence.js";
import { logRejectedLargePayload } from "../../logging/diagnostic-payload.js";
import { resolveHostedPluginSurfaceUrl } from "../hosted-plugin-surface-url.js";
import { readPreparedGatewayIngressAttribution } from "../ingress-attribution.js";
import { MAX_PAYLOAD_BYTES, MAX_PREAUTH_PAYLOAD_BYTES } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { startWebSocketKeepalive } from "../websocket-keepalive.js";
import { attachGatewayConnection, type GatewayConnectionOptions } from "./connection.js";
import type { PreauthConnectionBudget } from "./preauth-connection-budget.js";
import { takePublicWorkerIngress } from "./public-worker-ingress-context.js";
import { isWsPayloadLimitError, resolveSocketAddress } from "./ws-connection-diagnostics.js";
import type { WsOriginCheckMetrics } from "./ws-connection/message-handler-types.js";
import {
  attachWorkerWsMessageHandler,
  type WorkerConnectionService,
} from "./ws-connection/worker-connection.js";
import { prepareGatewayReceiverHandoff } from "./ws-receiver.js";
import {
  GATEWAY_WS_CONNECTION_KIND_PROPERTY,
  GATEWAY_WS_PREAUTH_BUDGET_PROPERTY,
  type GatewayIngressWebSocket,
} from "./ws-types.js";

export type AttachGatewayWsConnectionHandlerParams = GatewayConnectionOptions & {
  wss: WebSocketServer;
  preauthConnectionBudget: PreauthConnectionBudget;
  port: number;
  gatewayHost?: string;
  pluginSurfaceScheme?: "http" | "https";
  workerConnectionService?: WorkerConnectionService;
};

export function attachGatewayWsConnectionHandler(params: AttachGatewayWsConnectionHandlerParams) {
  const originCheckMetrics: WsOriginCheckMetrics = { hostHeaderFallbackAccepted: 0 };
  params.wss.on("connection", (socket, upgradeReq) => {
    if (params.connectionWork.isClosing) {
      socket.terminate();
      return;
    }
    const ingressSocket = socket as GatewayIngressWebSocket;
    const connectionKind = ingressSocket[GATEWAY_WS_CONNECTION_KIND_PROPERTY] ?? "gateway";
    const publicWorkerIngress =
      connectionKind === "worker" ? takePublicWorkerIngress(socket) : undefined;
    const preauthBudget =
      ingressSocket[GATEWAY_WS_PREAUTH_BUDGET_PROPERTY] ?? params.preauthConnectionBudget;
    const preauthBudgetKey = ingressSocket["__openclawPreauthBudgetKey"];
    ingressSocket["__openclawPreauthBudgetClaimed"] = true;
    const addresses = resolveSocketAddress(socket);
    const pluginNodeCapabilities =
      connectionKind === "gateway" ? (params.getPluginNodeCapabilities?.() ?? []) : [];
    const pluginSurfaceBaseUrl =
      pluginNodeCapabilities.length > 0
        ? resolveHostedPluginSurfaceUrl({
            port: params.port,
            forwardedHost: upgradeReq.headers["x-forwarded-host"],
            requestHost: upgradeReq.headers.host,
            forwardedProto: upgradeReq.headers["x-forwarded-proto"],
            localAddress: upgradeReq.socket?.localAddress,
            scheme: params.pluginSurfaceScheme,
          })
        : undefined;
    attachGatewayConnection({
      ...params,
      socket,
      connectionKind,
      request: upgradeReq,
      ingressAttribution: readPreparedGatewayIngressAttribution(upgradeReq),
      releasePreauth: () => preauthBudget.release(preauthBudgetKey),
      addresses,
      pluginNodeCapabilities,
      pluginSurfaceBaseUrl,
      originCheckMetrics,
      prepareAuthenticatedReceive: (role) => prepareGatewayReceiverHandoff(socket, role),
      onAuthenticated: (client, onHeartbeatTimeout) => {
        client.webSocket = socket;
        return startWebSocketKeepalive(socket, onHeartbeatTimeout, upgradeReq.socket);
      },
      attachTransport: (lifecycle) => {
        socket.once("error", (err) => {
          const client = lifecycle.getClient();
          if (isWsPayloadLimitError(err)) {
            logRejectedLargePayload({
              surface: client ? "gateway.ws.frame" : "gateway.ws.preauth",
              limitBytes:
                connectionKind === "worker"
                  ? WORKER_PROTOCOL_MAX_PAYLOAD_BYTES
                  : client
                    ? MAX_PAYLOAD_BYTES
                    : MAX_PREAUTH_PAYLOAD_BYTES,
              reason: client ? "ws_frame_limit" : "preauth_frame_limit",
            });
          }
          params.logWsControl.warn(
            `error conn=${lifecycle.connId} remote=${addresses.remoteAddr ?? "?"}: ${formatError(err)}`,
          );
          if (connectionKind === "worker") {
            lifecycle.close(1008, client ? "invalid-frame" : "invalid-handshake");
          } else {
            lifecycle.close();
          }
        });
        socket.on("pong", () => {
          const client = lifecycle.getClient();
          if (client?.presenceKey) {
            touchPresence(client.presenceKey);
          }
        });
        if (connectionKind === "worker") {
          return attachWorkerWsMessageHandler({
            ...lifecycle,
            socket,
            service: params.workerConnectionService,
            publicAdmission: publicWorkerIngress,
          });
        }
        return undefined;
      },
    });
  });
}
