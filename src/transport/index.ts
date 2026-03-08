/**
 * Barrel exports for the transport abstraction layer.
 */

export type {
  AgentMessage,
  AgentReply,
  AgentTransport,
  MessageHandler,
  ResolveSessionParams,
  Unsubscribe,
} from "./transport.js";

export { WebSocketTransport } from "./ws-transport.js";

export type { TransportBackend, TransportConfig } from "./factory.js";
export { createTransport } from "./factory.js";
