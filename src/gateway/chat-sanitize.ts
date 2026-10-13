import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { stripInternalMetadataForDisplay } from "../auto-reply/reply/display-text-sanitize.js";
import { extractInboundSenderLabel } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripUserEnvelopeForDisplay } from "../auto-reply/reply/user-envelope-display.js";
import { projectChatWorkContextForDisplay } from "../chat/work-context.js";
import { mapChatDisplayMessages } from "./chat-display-projection.map.js";
export { stripEnvelope } from "../shared/chat-envelope.js";

function extractMessageSenderLabel(entry: Record<string, unknown>): string | null {
  // Sender labels can be explicit fields or embedded in text/envelope content.
  // Preserve the first label found so user-origin rows keep human context.
  if (typeof entry.senderLabel === "string" && entry.senderLabel.trim()) {
    return entry.senderLabel.trim();
  }
  if (typeof entry.content === "string") {
    return extractInboundSenderLabel(entry.content);
  }
  if (Array.isArray(entry.content)) {
    for (const item of entry.content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") {
        continue;
      }
      const senderLabel = extractInboundSenderLabel(text);
      if (senderLabel) {
        return senderLabel;
      }
    }
  }
  if (typeof entry.text === "string") {
    return extractInboundSenderLabel(entry.text);
  }
  return null;
}

// Text content blocks need role-aware stripping because user messages carry
// inbound envelopes while assistant/tool content may carry internal metadata.
function stripEnvelopeFromContentWithRole(content: unknown[], role: string): unknown[] {
  const stripUserEnvelope = role === "user";
  return mapChatDisplayMessages(content, (item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    const isRoleTextBlock =
      entry.type === "text" ||
      (role === "user" && entry.type === "input_text") ||
      (role === "assistant" && (entry.type === "input_text" || entry.type === "output_text"));
    if (!isRoleTextBlock || typeof entry.text !== "string") {
      return item;
    }
    const stripped = stripUserEnvelope
      ? stripUserEnvelopeForDisplay(entry.text)
      : stripInternalMetadataForDisplay(entry.text);
    return stripped === entry.text ? item : { ...entry, text: stripped };
  });
}

/** Strips OpenClaw envelope metadata from one display message without mutating it. */
function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const projected = projectChatWorkContextForDisplay(message);
  const entry = projected as Record<string, unknown>;
  const role = typeof entry.role === "string" ? normalizeLowercaseStringOrEmpty(entry.role) : "";
  const stripUserEnvelope = role === "user";

  let next: Record<string, unknown> | undefined;
  // Labels come from the raw message before runtime-context and envelope removal.
  const senderLabel = stripUserEnvelope ? extractMessageSenderLabel(entry) : null;
  if (senderLabel && entry.senderLabel !== senderLabel) {
    next = { ...entry, senderLabel };
  }

  const field =
    typeof entry.content === "string" || Array.isArray(entry.content) ? "content" : "text";
  const content = entry[field];
  if (typeof content === "string" || (field === "content" && Array.isArray(content))) {
    const stripped = Array.isArray(content)
      ? stripEnvelopeFromContentWithRole(content, role)
      : stripUserEnvelope
        ? stripUserEnvelopeForDisplay(content)
        : stripInternalMetadataForDisplay(content);
    if (stripped !== content) {
      next ??= { ...entry };
      next[field] = stripped;
    }
  }

  return next ?? projected;
}

/** Strips envelope metadata from a message array, preserving the original array when unchanged. */
export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  return mapChatDisplayMessages(messages, stripEnvelopeFromMessage);
}
