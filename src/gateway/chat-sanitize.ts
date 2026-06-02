import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  stripInternalMetadataForDisplay,
  stripUserEnvelopeForDisplay,
} from "../auto-reply/reply/display-text-sanitize.js";
import { extractInboundSenderLabel } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope } from "../shared/chat-envelope.js";

export { stripEnvelope };

function extractMessageSenderLabel(entry: Record<string, unknown>): string | null {
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
        // Preserve sender attribution before stripping the visible envelope so
        // projections can show who spoke without leaking inbound metadata text.
        return senderLabel;
      }
    }
  }
  if (typeof entry.text === "string") {
    return extractInboundSenderLabel(entry.text);
  }
  return null;
}

function stripEnvelopeFromContentWithRole(
  content: unknown[],
  stripUserEnvelope: boolean,
): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      return item;
    }
    // Assistant/tool rows may carry internal metadata, but only user rows use
    // the external sender envelope grammar.
    const stripped = stripUserEnvelope
      ? stripUserEnvelopeForDisplay(entry.text)
      : stripInternalMetadataForDisplay(entry.text);
    if (stripped === entry.text) {
      return item;
    }
    changed = true;
    return {
      ...entry,
      text: stripped,
    };
  });
  return { content: next, changed };
}

/**
 * Returns a display-safe message copy with user envelopes and internal
 * metadata removed from string or text-block content.
 */
export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? normalizeLowercaseStringOrEmpty(entry.role) : "";
  const stripUserEnvelope = role === "user";

  let changed = false;
  const next: Record<string, unknown> = { ...entry };
  const senderLabel = stripUserEnvelope ? extractMessageSenderLabel(entry) : null;
  if (senderLabel && entry.senderLabel !== senderLabel) {
    next.senderLabel = senderLabel;
    changed = true;
  }

  if (typeof entry.content === "string") {
    const stripped = stripUserEnvelope
      ? stripUserEnvelopeForDisplay(entry.content)
      : stripInternalMetadataForDisplay(entry.content);
    if (stripped !== entry.content) {
      next.content = stripped;
      changed = true;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = stripEnvelopeFromContentWithRole(entry.content, stripUserEnvelope);
    if (updated.changed) {
      next.content = updated.content;
      changed = true;
    }
  } else if (typeof entry.text === "string") {
    const stripped = stripUserEnvelope
      ? stripUserEnvelopeForDisplay(entry.text)
      : stripInternalMetadataForDisplay(entry.text);
    if (stripped !== entry.text) {
      next.text = stripped;
      changed = true;
    }
  }

  return changed ? next : message;
}

/**
 * Applies stripEnvelopeFromMessage across a message list while preserving the
 * original array identity when no entry changes.
 */
export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((message) => {
    const stripped = stripEnvelopeFromMessage(message);
    if (stripped !== message) {
      changed = true;
    }
    return stripped;
  });
  return changed ? next : messages;
}
