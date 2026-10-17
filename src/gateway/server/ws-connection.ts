// Physical WebSocket ingress adapts into the shared Gateway connection owner.
import type { WebSocketServer } from "ws";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/index.js";
import {
  hasInternalDiagnosticEventInterest,
  onInternalDiagnosticEventInterest,
} from "../../infra/diagnostic-event-listener-presence.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { formatErrorMessage as formatError } from "../../infra/errors.js";
import { touchPresence } from "../../infra/system-presence.js";
import { logRejectedLargePayload } from "../../logging/diagnostic-payload.js";
import { resolveHostedPluginSurfaceUrl } from "../hosted-plugin-surface-url.js";
import { readPreparedGatewayIngressAttribution } from "../ingress-attribution.js";
import { MAX_PAYLOAD_BYTES } from "../payload-limits.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "../server-constants.js";
import { startWebSocketKeepalive } from "../websocket-keepalive.js";
import { attachGatewayConnection, type GatewayConnectionOptions } from "./connection.js";
import type { PreauthConnectionBudget } from "./preauth-connection-budget.js";
import { takePublicWorkerIngress } from "./public-worker-ingress-context.js";
import { installGatewayDeflateCodec } from "./ws-compression.js";
import {
  isWsPayloadLimitError,
  resolveSocketAddress,
  recordGatewayWsEvent,
} from "./ws-connection-diagnostics.js";
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
  let warnedDeflateCodec = false;
  let operators = 0;
  let connectionMetricsTimer: ReturnType<typeof setInterval> | undefined;
  const publishConnections = () => {
    if (!hasInternalDiagnosticEventInterest("gateway.ws.connections")) {
      clearInterval(connectionMetricsTimer);
      connectionMetricsTimer = undefined;
      return;
    }
    // Refresh late exporters and dropped snapshots, including after diagnostics re-enable.
    connectionMetricsTimer ??= setInterval(publishConnections, 30_000).unref();
    emitTrustedDiagnosticEvent({ type: "gateway.ws.connections", operators });
  };
  const stopConnectionMetrics = onInternalDiagnosticEventInterest(
    "gateway.ws.connections",
    publishConnections,
  );
  params.wss.on("close", () => {
    stopConnectionMetrics();
    clearInterval(connectionMetricsTimer);
  });
  publishConnections();
  params.wss.on("connection", (socket, upgradeReq) => {
    if (params.connectionWork.isClosing) {
      socket.terminate();
      return;
    }
    // Install before ws parses the first frame; the upgrade emits synchronously.
    const compression = installGatewayDeflateCodec(socket);
    if (!compression && !warnedDeflateCodec) {
      warnedDeflateCodec = true;
      params.logWsControl.warn(
        "unsupported ws permessage-deflate extension; compressed frames use the slower ws path",
      );
    }
    let batched = false;
    Object.assign(socket, {
      recordEventSent: recordGatewayWsEvent,
      acceptsDeflatedSegments: compression?.acceptsDeflatedSegments ?? false,
      batchWrites() {
        if (batched) {
          return;
        }
        batched = true;
        upgradeReq.socket.cork();
        process.nextTick(() => {
          batched = false;
          upgradeReq.socket.uncork();
        });
      },
      sendUncompressed(frame: string, callback?: (error?: Error) => void) {
        socket.send(frame, { compress: false }, callback);
      },
    });
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
        const stopKeepalive = startWebSocketKeepalive(
          socket,
          onHeartbeatTimeout,
          upgradeReq.socket,
        );
        const operator =
          connectionKind === "gateway" && (client.connect.role ?? "operator") === "operator";
        if (operator) {
          operators++;
          publishConnections();
        }
        return () => {
          stopKeepalive();
          if (operator) {
            operators--;
            publishConnections();
          }
        };
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
