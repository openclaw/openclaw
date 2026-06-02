import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Gateway event name mobile nodes use to report a lightweight alive signal. */
export const NODE_PRESENCE_ALIVE_EVENT = "node.presence.alive";

/** Persisted reasons for node alive events; keep aligned with gateway-protocol node schemas. */
const NODE_PRESENCE_ALIVE_REASONS = [
  "background",
  "silent_push",
  "bg_app_refresh",
  "significant_location",
  "manual",
  "connect",
] as const;

export type NodePresenceAliveReason = (typeof NODE_PRESENCE_ALIVE_REASONS)[number];

const NODE_PRESENCE_ALIVE_REASON_SET = new Set<string>(NODE_PRESENCE_ALIVE_REASONS);

export function normalizeNodePresenceAliveReason(value: unknown): NodePresenceAliveReason {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized && NODE_PRESENCE_ALIVE_REASON_SET.has(normalized)) {
    return normalized as NodePresenceAliveReason;
  }
  // Unknown client triggers should still count as an alive ping without expanding the
  // persisted reason vocabulary or failing older gateway protocol clients.
  return "background";
}
