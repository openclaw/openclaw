/**
 * Marketplace event types for P2P compute sharing.
 *
 * These events flow between seller nodes and the gateway via WebSocket,
 * following the same pattern as VNC tunnel relay events.
 */

/** Events sent by seller nodes to the gateway. */
export const MARKETPLACE_NODE_EVENTS = [
  /** Seller idle/active status change. */
  "marketplace.idle.status",
  /** Streaming response chunk from seller to buyer (via gateway relay). */
  "marketplace.proxy.chunk",
  /** Final message after seller finishes a proxy request (includes usage). */
  "marketplace.proxy.done",
  /** Error during proxy execution on seller node. */
  "marketplace.proxy.error",
] as const;

/** Events broadcast by the gateway. */
export const MARKETPLACE_GATEWAY_EVENTS = [
  /** A new seller became available for marketplace requests. */
  "marketplace.seller.available",
  /** A seller is no longer available. */
  "marketplace.seller.unavailable",
] as const;

/** Idle status reported by seller nodes. */
export type MarketplaceIdleStatus = "active" | "idle" | "sharing";

/** Payload for marketplace.idle.status events. */
export type MarketplaceIdleStatusPayload = {
  status: MarketplaceIdleStatus;
  lastActiveAtMs: number;
  supportedModels?: string[];
};

/** Payload for marketplace.proxy.chunk events (streaming relay). */
export type MarketplaceProxyChunkPayload = {
  requestId: string;
  /** SSE data line content (the raw JSON from Claude's stream). */
  data: string;
  /** True if this is the final chunk in the stream. */
  done?: boolean;
};

/** Payload for marketplace.proxy.done events (completion). */
export type MarketplaceProxyDonePayload = {
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
};

/** Payload for marketplace.proxy.error events. */
export type MarketplaceProxyErrorPayload = {
  requestId: string;
  code: string;
  message: string;
};
