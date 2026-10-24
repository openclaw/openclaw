import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import type { MessageGroup, NormalizedMessage } from "./chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "./heartbeat-display.ts";
import {
  extractText,
  extractTextCached,
  isEmptyUserTextOnlyMessage,
  readTranscriptMediaEntries,
} from "./message-extract.ts";

const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";

// Media and unknown blocks are visible outcomes; tool and thinking blocks are
// activity. Classifying prepared content keeps replies out of work rollups.
export function resolveMessageVisibleContent(
  message: unknown,
  normalized: NormalizedMessage,
): MessageGroup["visibleContent"] {
  if (readTranscriptMediaEntries(message).length > 0) {
    return "non-text";
  }
  let hasText = false;
  for (const block of normalized.content) {
    if (block.type === "text") {
      hasText ||= Boolean(block.text?.trim());
    } else if (
      block.type !== "thinking" &&
      !isToolCallContentType(block.type) &&
      !isToolResultContentType(block.type)
    ) {
      return "non-text";
    }
  }
  return hasText || extractTextCached(message)?.trim() ? "text" : "none";
}

function isSyntheticTranscriptRepairToolResult(message: unknown): boolean {
  const entry = asNullableRecord(message);
  if (!entry || normalizeLowercaseStringOrEmpty(entry.role) !== "toolresult") {
    return false;
  }
  const text = extractText(message);
  return text?.trim() === SYNTHETIC_TRANSCRIPT_REPAIR_RESULT;
}

export function isHiddenAssistantStreamText(text: string): boolean {
  return stripHeartbeatTokenForDisplay(text).shouldSkip;
}

export function shouldHideAssistantChatMessage(message: unknown): boolean {
  return isAssistantHeartbeatAckForDisplay(message);
}

export function isVisibleChatHistoryMessage(message: unknown): boolean {
  return !(
    shouldHideAssistantChatMessage(message) ||
    isSyntheticTranscriptRepairToolResult(message) ||
    isEmptyUserTextOnlyMessage(message)
  );
}

export function visibleChatHistoryMessages(messages: unknown): unknown[] {
  return Array.isArray(messages) ? messages.filter(isVisibleChatHistoryMessage) : [];
}
