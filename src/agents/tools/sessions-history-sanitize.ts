import { redactSensitiveText } from "../../logging/redact.js";
import { truncateUtf16Safe } from "../../utils.js";

const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;

function isReasoningContentType(type: string): boolean {
  return type === "thinking" || type === "redacted_thinking";
}

export function truncateHistoryText(text: string): {
  text: string;
  truncated: boolean;
  redacted: boolean;
} {
  // Redact credentials, API keys, tokens before returning session history.
  // Prevents sensitive data leakage via sessions_history tool (OC-07).
  const sanitized = redactSensitiveText(text);
  const redacted = sanitized !== text;
  if (sanitized.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) {
    return { text: sanitized, truncated: false, redacted };
  }
  const cut = truncateUtf16Safe(sanitized, SESSIONS_HISTORY_TEXT_MAX_CHARS);
  return { text: `${cut}\n…(truncated)…`, truncated: true, redacted };
}

export function sanitizeHistoryContentBlock(
  block: unknown,
  opts?: {
    preserveReasoningBlocks?: boolean;
  },
): {
  block: unknown;
  truncated: boolean;
  redacted: boolean;
  omitted: boolean;
} {
  if (!block || typeof block !== "object") {
    return { block, truncated: false, redacted: false, omitted: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (isReasoningContentType(type)) {
    if (opts?.preserveReasoningBlocks) {
      return { block, truncated: false, redacted: false, omitted: false };
    }
    return { block: null, truncated: true, redacted: false, omitted: true };
  }
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (type === "image") {
    const data = typeof entry.data === "string" ? entry.data : undefined;
    const bytes = data ? data.length : undefined;
    if ("data" in entry) {
      delete entry.data;
      truncated = true;
    }
    entry.omitted = true;
    if (bytes !== undefined) {
      entry.bytes = bytes;
    }
  }
  return { block: entry, truncated, redacted, omitted: false };
}

export function sanitizeHistoryMessage(
  message: unknown,
  opts?: {
    preserveReasoningBlocks?: boolean;
  },
): {
  message: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!message || typeof message !== "object") {
    return { message, truncated: false, redacted: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  // Tool result details often contain very large nested payloads.
  if ("details" in entry) {
    delete entry.details;
    truncated = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    truncated = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    truncated = true;
  }

  if (typeof entry.content === "string") {
    const res = truncateHistoryText(entry.content);
    entry.content = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeHistoryContentBlock(block, opts));
    const kept = updated.filter((item) => !item.omitted).map((item) => item.block);
    const needsAssistantPlaceholder = entry.role === "assistant" && kept.length === 0;
    entry.content = needsAssistantPlaceholder ? [{ type: "text", text: "" }] : kept;
    truncated ||= updated.some((item) => item.truncated);
    redacted ||= updated.some((item) => item.redacted);
  }
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  return { message: entry, truncated, redacted };
}

export function hasReasoningHistoryContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as { content?: unknown };
  if (!Array.isArray(entry.content)) {
    return false;
  }
  return entry.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return typeof type === "string" && isReasoningContentType(type);
  });
}

export function hasVisibleHistoryPreviewContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as { content?: unknown; text?: unknown };
  if (typeof entry.content === "string") {
    return entry.content.trim().length > 0;
  }
  if (Array.isArray(entry.content)) {
    if (entry.content.length === 0) {
      return false;
    }
    return entry.content.some((block) => {
      if (!block || typeof block !== "object") {
        return true;
      }
      const text = (block as { text?: unknown }).text;
      return typeof text !== "string" || text.length > 0;
    });
  }
  if (typeof entry.text === "string") {
    return entry.text.trim().length > 0;
  }
  return true;
}
