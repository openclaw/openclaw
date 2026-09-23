/** Node-compatible WebSocket transport and observer ticket helpers. */
export {
  createWebSocketStream,
  WebSocket,
  WebSocketServer,
} from "../../packages/gateway-client/src/websocket.js";
export type { ClientOptions, Data, RawData } from "../../packages/gateway-client/src/websocket.js";
export { createOneTimeTicketStore } from "../shared/one-time-ticket-store.js";
export type { OneTimeTicketStore } from "../shared/one-time-ticket-store.js";
export { startWebSocketKeepalive } from "../gateway/websocket-keepalive.js";
export type {
  WebSocketHeartbeatDiagnostics,
  WebSocketKeepaliveSocket,
} from "../gateway/websocket-keepalive.js";
export { rejectWebSocketUpgrade } from "../shared/websocket-upgrade-reject.js";
export type { WebSocketUpgradeRejection } from "../shared/websocket-upgrade-reject.js";
