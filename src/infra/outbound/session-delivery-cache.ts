// Per-session resolved delivery context cache.
//
// The previous hot path in acp-spawn-parent-stream.ts:emit() and adjacent
// emitters called loadSessionStore() + structuredClone on every emission. This
// module provides an in-memory lookup keyed by sessionKey so the hot path only
// pays a Map.get cost; writes happen out-of-band when the session-binding
// service publishes updates (wired in Phase 1.6 / Phase 2).

import type { DeliveryContext } from "../../utils/delivery-context.types.js";

const cache = new Map<string, DeliveryContext>();

export function getCachedDeliveryContext(sessionKey: string): DeliveryContext | undefined {
  return cache.get(sessionKey);
}

export function setCachedDeliveryContext(sessionKey: string, ctx: DeliveryContext): void {
  cache.set(sessionKey, ctx);
}

export function clearCachedDeliveryContext(sessionKey: string): void {
  cache.delete(sessionKey);
}

// Test-only helper. Production code should not depend on global reset.
export function resetDeliveryCacheForTest(): void {
  cache.clear();
}
