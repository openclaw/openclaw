import {
  extractInboundSenderLabel,
  stripInboundMetadata,
  stripVisibleTranscriptControlText,
} from "../auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

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
  stripVisibleControls: boolean,
): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [item];
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      return [item];
    }
    const inboundStripped = stripVisibleControls
      ? stripVisibleTranscriptControlText(entry.text)
      : stripInboundMetadata(entry.text);
    const stripped = stripUserEnvelope
      ? stripMessageIdHints(stripEnvelope(inboundStripped))
      : inboundStripped;
    if (stripped === entry.text) {
      return [item];
    }
    changed = true;
    if (!stripped.trim()) {
      return [];
    }
    return [
      {
        ...entry,
        text: stripped,
      },
    ];
  });
  return { content: next, changed };
}

function shouldStripVisibleTranscriptText(role: string): boolean {
  return (
    role === "" ||
    role === "unknown" ||
    role === "user" ||
    role === "assistant" ||
    role === "system"
  );
}

export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? normalizeLowercaseStringOrEmpty(entry.role) : "";
  const stripUserEnvelope = role === "user";
  const stripVisibleControls = shouldStripVisibleTranscriptText(role);

  let changed = false;
  const next: Record<string, unknown> = { ...entry };
  const senderLabel = stripUserEnvelope ? extractMessageSenderLabel(entry) : null;
  if (senderLabel && entry.senderLabel !== senderLabel) {
    next.senderLabel = senderLabel;
    changed = true;
  }

  if (typeof entry.content === "string") {
    const inboundStripped = stripVisibleControls
      ? stripVisibleTranscriptControlText(entry.content)
      : stripInboundMetadata(entry.content);
    const stripped = stripUserEnvelope
      ? stripMessageIdHints(stripEnvelope(inboundStripped))
      : inboundStripped;
    if (stripped !== entry.content) {
      next.content = stripped;
      changed = true;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = stripEnvelopeFromContentWithRole(
      entry.content,
      stripUserEnvelope,
      stripVisibleControls,
    );
    if (updated.changed) {
      next.content = updated.content;
      changed = true;
    }
  } else if (typeof entry.text === "string") {
    const inboundStripped = stripVisibleControls
      ? stripVisibleTranscriptControlText(entry.text)
      : stripInboundMetadata(entry.text);
    const stripped = stripUserEnvelope
      ? stripMessageIdHints(stripEnvelope(inboundStripped))
      : inboundStripped;
    if (stripped !== entry.text) {
      next.text = stripped;
      changed = true;
    }
  }

  return changed ? next : message;
}

function isEmptyVisibleTranscriptMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? normalizeLowercaseStringOrEmpty(entry.role) : "";
  if (!shouldStripVisibleTranscriptText(role)) {
    return false;
  }
  if (typeof entry.content === "string") {
    return entry.content.trim().length === 0;
  }
  if (typeof entry.text === "string") {
    return entry.text.trim().length === 0;
  }
  if (!Array.isArray(entry.content)) {
    return false;
  }
  if (entry.content.length === 0) {
    return true;
  }
  return entry.content.every((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" && block.text.trim() === "";
  });
}

export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    const stripped = stripEnvelopeFromMessage(message);
    if (stripped !== message) {
      changed = true;
    }
    if (isEmptyVisibleTranscriptMessage(stripped)) {
      changed = true;
      continue;
    }
    next.push(stripped);
  }
  return changed ? next : messages;
}
