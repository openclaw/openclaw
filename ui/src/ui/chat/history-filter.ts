import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import { extractTextCached } from "./message-extract.ts";

export const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
export const LEAKED_SESSION_RESET_PROMPT_PREFIX =
  "A new session was started via /new or /reset. If runtime-provided startup context is included for this first turn, use it before responding to the user.";

function extractLowercaseHistoryText(message: unknown): string {
  const text = extractTextCached(message);
  if (typeof text !== "string") {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(text.trim());
}

function hasLeakedExecStatus(text: string): boolean {
  return (
    text.includes("exec started") ||
    text.includes("exec completed") ||
    text.includes("exec finished") ||
    text.includes("exec failed") ||
    text.includes("exec denied")
  );
}

export function isSyntheticTranscriptRepairToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "toolresult") {
    return false;
  }
  return extractLowercaseHistoryText(message) === SYNTHETIC_TRANSCRIPT_REPAIR_RESULT;
}

export function isLeakedInternalHistoryMessage(message: unknown): boolean {
  const lower = extractLowercaseHistoryText(message);
  if (!lower) {
    return false;
  }
  const hasExecStatus = hasLeakedExecStatus(lower);
  if (hasExecStatus && (lower.startsWith("system:") || lower.startsWith("system (untrusted):"))) {
    return true;
  }
  if (lower.startsWith("sender (untrusted metadata):") && hasExecStatus) {
    return true;
  }
  return lower.startsWith(normalizeLowercaseStringOrEmpty(LEAKED_SESSION_RESET_PROMPT_PREFIX));
}

export function shouldHideHistoryMessage(message: unknown): boolean {
  return isSyntheticTranscriptRepairToolResult(message) || isLeakedInternalHistoryMessage(message);
}
