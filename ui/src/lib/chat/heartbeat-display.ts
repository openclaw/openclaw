import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Historical transcripts keep their original bytes after heartbeat retirement.
// This display-only contract must not depend on the retired execution engine.
const HISTORICAL_HEARTBEAT_ACK_MAX_CHARS = 300;
const HISTORICAL_HEARTBEAT_TOKEN = "HEARTBEAT_OK";

function stripHistoricalToken(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  let didStrip = false;
  while (text) {
    if (text.startsWith(HISTORICAL_HEARTBEAT_TOKEN)) {
      text = text.slice(HISTORICAL_HEARTBEAT_TOKEN.length).trimStart();
      didStrip = true;
    } else if (/HEARTBEAT_OK[^\w]{0,4}$/.test(text)) {
      const index = text.lastIndexOf(HISTORICAL_HEARTBEAT_TOKEN);
      const before = text.slice(0, index).trimEnd();
      text = before
        ? `${before}${text.slice(index + HISTORICAL_HEARTBEAT_TOKEN.length).trimStart()}`.trimEnd()
        : "";
      didStrip = true;
    } else {
      break;
    }
  }
  return { text: text.replace(/\s+/g, " ").trim(), didStrip };
}

export function stripHeartbeatTokenForDisplay(
  raw: string,
  maxAckChars = HISTORICAL_HEARTBEAT_ACK_MAX_CHARS,
): { shouldSkip: boolean; text: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "" };
  }
  if (!trimmed.includes(HISTORICAL_HEARTBEAT_TOKEN)) {
    return { shouldSkip: false, text: trimmed };
  }
  const original = stripHistoricalToken(trimmed);
  const normalized = stripHistoricalToken(
    trimmed
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, ""),
  );
  const result = original.didStrip && original.text ? original : normalized;
  if (!result.didStrip) {
    return { shouldSkip: false, text: trimmed };
  }
  const text = /^[*`~_]+$/.test(result.text) ? "" : result.text;
  return { shouldSkip: text.length === 0 || text.length <= maxAckChars, text };
}

function resolveDisplayContent(content: unknown): {
  text: string;
  hasVisibleNonTextContent: boolean;
} {
  if (typeof content === "string") {
    return { text: content, hasVisibleNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasVisibleNonTextContent: content != null };
  }
  let hasVisibleNonTextContent = false;
  const text: string[] = [];
  content.forEach((block) => {
    const entry = asOptionalObjectRecord(block);
    if (entry?.type === "text" && typeof entry.text === "string") {
      text.push(entry.text);
    } else if (entry?.type !== "thinking" && entry?.type !== "reasoning") {
      hasVisibleNonTextContent = true;
    }
  });
  return { text: text.join(""), hasVisibleNonTextContent };
}

export function isAssistantHeartbeatAckForDisplay(message: unknown): boolean {
  const entry = asOptionalObjectRecord(message);
  if (!entry) {
    return false;
  }
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "assistant") {
    return false;
  }
  if (typeof entry.senderLabel === "string" && entry.senderLabel.trim()) {
    return false;
  }

  const content =
    typeof entry.content === "string" || Array.isArray(entry.content) ? entry.content : entry.text;
  const { text, hasVisibleNonTextContent } = resolveDisplayContent(content);
  if (hasVisibleNonTextContent) {
    return false;
  }
  // Reasoning-only rows have no answer text, but that is not a heartbeat acknowledgement.
  return text.trim().length > 0 && stripHeartbeatTokenForDisplay(text).shouldSkip;
}
