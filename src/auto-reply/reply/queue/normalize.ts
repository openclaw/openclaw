import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { QueueDropPolicy } from "./types.js";

const queueModes = new Map<string, QueueMode>([
  ["interrupt", "interrupt"],
  ["interrupts", "interrupt"],
  ["abort", "interrupt"],
  ["steer", "steer"],
  ["steering", "steer"],
  ["followup", "followup"],
  ["follow-ups", "followup"],
  ["followups", "followup"],
  ["collect", "collect"],
  ["coalesce", "collect"],
]);
const persistedQueueModes = new Map<string, QueueMode>([
  ...queueModes,
  ["queue", "steer"],
  ["queued", "steer"],
  ["steer+backlog", "followup"],
  ["steer-backlog", "followup"],
  ["steer_backlog", "followup"],
]);
const queueDropPolicies = new Map<string, QueueDropPolicy>([
  ["old", "old"],
  ["oldest", "old"],
  ["new", "new"],
  ["newest", "new"],
  ["summarize", "summarize"],
  ["summary", "summarize"],
]);

/** Normalizes user-entered queue mode aliases from directives/config. */
export function normalizeQueueMode(raw?: string): QueueMode | undefined {
  return queueModes.get(normalizeOptionalLowercaseString(raw) ?? "");
}

/** Normalizes persisted legacy queue mode aliases into current queue modes. */
export function normalizePersistedQueueMode(raw?: string): QueueMode | undefined {
  return persistedQueueModes.get(normalizeOptionalLowercaseString(raw) ?? "");
}

/** Normalizes queue drop policy aliases from directives/config. */
export function normalizeQueueDropPolicy(raw?: string): QueueDropPolicy | undefined {
  return queueDropPolicies.get(normalizeOptionalLowercaseString(raw) ?? "");
}
