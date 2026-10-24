import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  stripHeartbeatToken,
} from "../../../../src/auto-reply/heartbeat.js";

export function stripHeartbeatTokenForDisplay(raw: string): { shouldSkip: boolean; text: string } {
  const result = stripHeartbeatToken(raw, { mode: "message" });
  const text = result.didStrip && /^[*`~_]+$/.test(result.text) ? "" : result.text;
  return {
    shouldSkip:
      result.shouldSkip || (result.didStrip && text.length <= DEFAULT_HEARTBEAT_ACK_MAX_CHARS),
    text,
  };
}

export function isAssistantHeartbeatAckForDisplay(message: unknown): boolean {
  const entry = asOptionalObjectRecord(message);
  if (!entry || normalizeLowercaseStringOrEmpty(entry.role) !== "assistant") {
    return false;
  }
  if (typeof entry.senderLabel === "string" && entry.senderLabel.trim()) {
    return false;
  }

  const content =
    typeof entry.content === "string" || Array.isArray(entry.content) ? entry.content : entry.text;
  let text = "";
  let hasVisibleNonTextContent = false;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    content.forEach((block) => {
      const blockEntry = asOptionalObjectRecord(block);
      if (blockEntry?.type === "text" && typeof blockEntry.text === "string") {
        parts.push(blockEntry.text);
      } else if (blockEntry?.type !== "thinking" && blockEntry?.type !== "reasoning") {
        hasVisibleNonTextContent = true;
      }
    });
    text = parts.join("");
  } else {
    hasVisibleNonTextContent = content != null;
  }
  if (hasVisibleNonTextContent) {
    return false;
  }
  // Reasoning-only rows have no answer text, but that is not a heartbeat acknowledgement.
  return text.trim().length > 0 && stripHeartbeatTokenForDisplay(text).shouldSkip;
}
