import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import { extractTextCached } from "./message-extract.ts";

export const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
export const LEAKED_SESSION_RESET_PROMPT_PREFIX =
  "A new session was started via /new or /reset. If runtime-provided startup context is included for this first turn, use it before responding to the user.";
const LEAKED_EXEC_STATUS_ACTION_PATTERN = "(?:started|completed|finished|failed|denied)";
const LEAKED_SYSTEM_EXEC_STATUS_PATTERN = new RegExp(
  String.raw`^system(?: \(untrusted\))?:\s*\[[^\]\n]+\]\s*exec ${LEAKED_EXEC_STATUS_ACTION_PATTERN}\s*\([^\)\n]+\)`,
);
const LEAKED_SENDER_METADATA_EXEC_STATUS_PATTERN = new RegExp(
  String.raw`^sender \(untrusted metadata\):[\s\S]*"label"\s*:\s*"openclaw-control-ui"[\s\S]*\[[^\]\n]+\]\s*exec ${LEAKED_EXEC_STATUS_ACTION_PATTERN}\b`,
);

function extractLowercaseHistoryText(message: unknown): string {
  const text = extractTextCached(message);
  if (typeof text !== "string") {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(text.trim());
}

function hasLeakedSystemExecStatus(text: string): boolean {
  return LEAKED_SYSTEM_EXEC_STATUS_PATTERN.test(text);
}

function hasLeakedSenderMetadataExecStatus(text: string): boolean {
  return LEAKED_SENDER_METADATA_EXEC_STATUS_PATTERN.test(text);
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
  if (hasLeakedSystemExecStatus(lower)) {
    return true;
  }
  if (hasLeakedSenderMetadataExecStatus(lower)) {
    return true;
  }
  return lower.startsWith(normalizeLowercaseStringOrEmpty(LEAKED_SESSION_RESET_PROMPT_PREFIX));
}

export function shouldHideHistoryMessage(message: unknown): boolean {
  return isSyntheticTranscriptRepairToolResult(message) || isLeakedInternalHistoryMessage(message);
}
