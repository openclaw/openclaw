import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";

/**
 * WebSocket client for gateway connections
 * Currently uses the ws library (node:ws)
 *
 * Note: When migrating to Bun/Elysia, this type should be updated to use
 * a generic interface that works with both ws and Bun native WebSocket.
 */
export type GatewayWsClient = {
  /** WebSocket connection */
  socket: WebSocket;
  /** Connection parameters from handshake */
  connect: ConnectParams;
  /** Unique connection ID */
  connId: string;
  /** Presence tracking key (deviceId or instanceId) */
  presenceKey?: string;
};
