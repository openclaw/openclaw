import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
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

export function modelAuthEventInvalidates(
  event: Pick<GatewayEventFrame, "event" | "payload">,
): boolean {
  return (
    event.event === "config.changed" ||
    (event.event === "chat.metadata.changed" &&
      asNullableRecord(event.payload)?.authChanged !== false)
  );
}

/** Retire sharing eligibility without cancelling existing consumers' own reads. */
export function invalidateModelAuthStatusRequests(client: GatewayBrowserClient): void {
  authReads.get(client)?.entries.clear();
}
