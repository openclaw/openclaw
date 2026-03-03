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
  /** Set of sessionKeys this client has interacted with via chat.send or chat.history.
   *  Clients with this set populated only receive chat events for these sessions.
   *  Empty/undefined means client receives all chat events (legacy behavior). */
  chatSessionKeys?: Set<string>;
};
