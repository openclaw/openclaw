// Shared subagent helpers for routing, labels, and transcript text.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeRunStatusText } from "../../agents/run-status-text.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry-read.js";
import { truncateUtf16Safe } from "../../utils.js";

export function resolveSubagentLabel(entry: SubagentRunRecord, fallback = "subagent") {
  const raw = normalizeOptionalString(entry.label) || normalizeOptionalString(entry.task) || "";
  return raw || fallback;
}

export function formatRunLabel(entry: SubagentRunRecord, options?: { maxLength?: number }) {
  const raw = sanitizeRunStatusText(resolveSubagentLabel(entry)) || "subagent";
  const maxLength = options?.maxLength ?? 72;
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return raw;
  }
  return raw.length > maxLength ? `${truncateUtf16Safe(raw, maxLength).trimEnd()}…` : raw;
}
