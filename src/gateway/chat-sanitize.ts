import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";

export { stripEnvelope };

function stripEnvelopeFromContent(content: unknown[]): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      return item;
    }
    const stripped = stripMessageIdHints(stripEnvelope(entry.text));
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

export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role !== "user") {
    return message;
  }

  let changed = false;
  const next: Record<string, unknown> = { ...entry };

  if (typeof entry.content === "string") {
    const stripped = stripMessageIdHints(stripEnvelope(entry.content));
    if (stripped !== entry.content) {
      next.content = stripped;
      changed = true;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = stripEnvelopeFromContent(entry.content);
    if (updated.changed) {
      next.content = updated.content;
      changed = true;
    }
  } else if (typeof entry.text === "string") {
    const stripped = stripMessageIdHints(stripEnvelope(entry.text));
    if (stripped !== entry.text) {
      next.text = stripped;
      changed = true;
    }
  }

  return changed ? next : message;
}

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

const MAX_CONTENT_CHARS = 50_000;
const TRUNCATION_SUFFIX = "\n\n… [content truncated for display]";

function truncateString(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) {
    return text;
  }
  return text.slice(0, MAX_CONTENT_CHARS) + TRUNCATION_SUFFIX;
}

function truncateContentArray(content: unknown[]): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.text !== "string" || entry.text.length <= MAX_CONTENT_CHARS) {
      return item;
    }
    changed = true;
    return { ...entry, text: truncateString(entry.text) };
  });
  return { content: next, changed };
}

function truncateMessageContent(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...entry };

  if (typeof entry.content === "string" && entry.content.length > MAX_CONTENT_CHARS) {
    next.content = truncateString(entry.content);
    changed = true;
  } else if (Array.isArray(entry.content)) {
    const updated = truncateContentArray(entry.content);
    if (updated.changed) {
      next.content = updated.content;
      changed = true;
    }
  }

  if (typeof entry.text === "string" && entry.text.length > MAX_CONTENT_CHARS) {
    next.text = truncateString(entry.text);
    changed = true;
  }

  return changed ? next : message;
}

export function truncateMessagesForChatHistory(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((message) => {
    const truncated = truncateMessageContent(message);
    if (truncated !== message) {
      changed = true;
    }
    return truncated;
  });
  return changed ? next : messages;
}
