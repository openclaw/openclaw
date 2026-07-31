import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../routing/session-key.js";

const DERIVED_SYSTEM_EVENT_QUEUE_PREFIX = "\u0000openclaw:system-event:";

/** Keeps per-agent global-session events isolated while preserving the logical session key. */
export function resolveSystemEventQueueKey(params: {
  sessionKey: string;
  agentId?: string;
}): string {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    throw new Error("system events require a sessionKey");
  }
  if (sessionKey.startsWith(DERIVED_SYSTEM_EVENT_QUEUE_PREFIX)) {
    throw new Error("system event sessionKey uses the reserved derived-queue namespace");
  }
  const agentId = normalizeOptionalString(params.agentId);
  // System-event queues are process-transient. The reserved NUL namespace keeps
  // derived agent/global queues disjoint from every pass-through session key.
  return sessionKey === "global" && agentId
    ? `${DERIVED_SYSTEM_EVENT_QUEUE_PREFIX}${JSON.stringify([normalizeAgentId(agentId), sessionKey])}`
    : sessionKey;
}
