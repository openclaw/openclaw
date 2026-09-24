import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult } from "../api/types.ts";

export type ModelAuthRequest = {
  promise: Promise<ModelAuthStatusResult>;
  subscribers: Set<object>;
  refreshAt?: number;
};

type ModelAuthRequestState = {
  entries: Map<string, ModelAuthRequest>;
  refreshes: number;
};

// Startup invalidation must not load auth presentation or provider helpers.
export const authReads = new WeakMap<GatewayBrowserClient, ModelAuthRequestState>();

/** Retire sharing eligibility without cancelling existing consumers' own reads. */
export function invalidateModelAuthStatusRequests(client: GatewayBrowserClient): void {
  authReads.get(client)?.entries.clear();
}
