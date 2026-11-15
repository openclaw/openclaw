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
  agentId?: string,
): boolean {
  if (event.event !== "chat.metadata.changed") {
    return false;
  }
  const payload = asNullableRecord(event.payload);
  // Config commits precede prepared auth publication; only its committed facts retire reads.
  return (
    payload?.authChanged !== false &&
    (agentId === undefined || typeof payload?.agentId !== "string" || payload.agentId === agentId)
  );
}

/** Retire sharing eligibility without cancelling existing consumers' own reads. */
export function invalidateModelAuthStatusRequests(
  client: GatewayBrowserClient,
  agentId?: string,
): void {
  const entries = authReads.get(client)?.entries;
  if (agentId === undefined) {
    entries?.clear();
  } else {
    entries?.delete(JSON.stringify([agentId, false]));
    entries?.delete(JSON.stringify([agentId, true]));
  }
}
