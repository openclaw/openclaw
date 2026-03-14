import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
  clientIp?: string;
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
  /**
   * Session keys this connection has interacted with via chat.send or
   * chat.history.  Used to scope chat event delivery — connections only
   * receive chat events for sessions they have participated in (unless
   * they hold operator.admin scope, which always receives all events).
   * Undefined/empty means the client has not declared interest in any
   * session yet and will receive all chat events for backward
   * compatibility.
   */
  chatSessionKeys?: Set<string>;
};
