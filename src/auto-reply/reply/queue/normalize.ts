import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import type { QueueDropPolicy, QueueMode } from "./types.js";

export function normalizeQueueMode(raw?: string): QueueMode | undefined {
  const cleaned = normalizeOptionalLowercaseString(raw);
  if (!cleaned) {
    return undefined;
  }
  if (cleaned === "interrupt" || cleaned === "interrupts" || cleaned === "abort") {
    return "interrupt";
  }
  if (cleaned === "followup" || cleaned === "follow-ups" || cleaned === "followups") {
    return "followup";
  }
  if (cleaned === "collect" || cleaned === "coalesce") {
    return "collect";
  }
  return undefined;
}

export function normalizeQueueDropPolicy(raw?: string): QueueDropPolicy | undefined {
  const cleaned = normalizeOptionalLowercaseString(raw);
  if (!cleaned) {
    return undefined;
  }
  if (cleaned === "old" || cleaned === "oldest") {
    return "old";
  }
  if (cleaned === "new" || cleaned === "newest") {
    return "new";
  }
  if (cleaned === "summarize" || cleaned === "summary") {
    return "summarize";
  }
  return undefined;
}
