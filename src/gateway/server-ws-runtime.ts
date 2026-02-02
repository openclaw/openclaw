import type { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { setLocalGatewayDispatcher } from "./local-dispatch.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { handleGatewayRequest } from "./server-methods.js";
import { attachGatewayWsConnectionHandler } from "./server/ws-connection.js";

export function attachGatewayWsHandlers(params: {
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  port: number;
  gatewayHost?: string;
  canvasHostEnabled: boolean;
  canvasHostServerPort?: number;
  resolvedAuth: ResolvedGatewayAuth;
  gatewayMethods: string[];
  events: string[];
  logGateway: ReturnType<typeof createSubsystemLogger>;
  logHealth: ReturnType<typeof createSubsystemLogger>;
  logWsControl: ReturnType<typeof createSubsystemLogger>;
  extraHandlers: GatewayRequestHandlers;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  context: GatewayRequestContext;
}) {
  attachGatewayWsConnectionHandler({
    wss: params.wss,
    clients: params.clients,
    port: params.port,
    gatewayHost: params.gatewayHost,
    canvasHostEnabled: params.canvasHostEnabled,
    canvasHostServerPort: params.canvasHostServerPort,
    resolvedAuth: params.resolvedAuth,
    gatewayMethods: params.gatewayMethods,
    events: params.events,
    logGateway: params.logGateway,
    logHealth: params.logHealth,
    logWsControl: params.logWsControl,
    extraHandlers: params.extraHandlers,
    broadcast: params.broadcast,
    buildRequestContext: () => params.context,
  });

  setLocalGatewayDispatcher(async (opts) => {
    const req = {
      type: "req",
      id: randomUUID(),
      method: opts.method,
      params: (opts.params ?? {}) as Record<string, unknown>,
    };
    const client = {
      connect: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          displayName: opts.clientDisplayName,
          version: opts.clientVersion ?? "dev",
          platform: opts.platform ?? process.platform,
          mode: opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
          instanceId: opts.instanceId,
        },
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.write",
        ],
      },
    };

    return await new Promise((resolve, reject) => {
      let settled = false;
      const respond = (ok: boolean, payload?: unknown, error?: { message?: string }) => {
        if (settled) {
          return;
        }
        settled = true;
        if (ok) {
          resolve(payload);
        } else {
          reject(new Error(error?.message ?? "gateway request failed"));
        }
      };
      void handleGatewayRequest({
        req,
        respond,
        client,
        isWebchatConnect: () => false,
        extraHandlers: params.extraHandlers,
        context: params.context,
      }).catch((err) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  });
}
