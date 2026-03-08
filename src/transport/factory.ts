/**
 * Transport factory — instantiates the configured AgentTransport backend.
 *
 * Default: "websocket" (zero-config, wraps callGateway).
 * Future:  "redis", "kafka", …
 */

import type { AgentTransport } from "./transport.js";
import { WebSocketTransport } from "./ws-transport.js";

export type TransportBackend = "websocket" | "redis" | "kafka";

export interface TransportConfig {
  transport?: {
    backend?: TransportBackend;
    redis?: {
      url?: string;
      prefix?: string;
    };
    kafka?: {
      brokers?: string[];
      clientId?: string;
    };
  };
}

export function createTransport(cfg?: TransportConfig): AgentTransport {
  const backend: TransportBackend = cfg?.transport?.backend ?? "websocket";

  switch (backend) {
    case "websocket":
      return new WebSocketTransport();

    case "redis":
      throw new Error(
        "Redis transport is not yet implemented. See Phase 5 of the transport abstraction plan.",
      );

    case "kafka":
      throw new Error(
        "Kafka transport is not yet implemented. See Phase 6 of the transport abstraction plan.",
      );

    default:
      return new WebSocketTransport();
  }
}
