import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";

const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;

function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) {
    return true;
  }
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) {
    return true;
  }
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) {
    return text;
  }
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) {
    return text;
  }
  return text.slice(match[0].length);
}

function stripMessageIdHints(text: string): string {
  if (!text.includes("[message_id:")) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}

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

/**
 * Extract text content from a message for heartbeat detection.
 */
function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const entry = message as Record<string, unknown>;
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (Array.isArray(entry.content)) {
    return entry.content
      .filter(
        (item): item is { type: string; text: string } =>
          !!item && typeof item === "object" && (item as Record<string, unknown>).type === "text",
      )
      .map((item) => item.text)
      .join("\n");
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  return "";
}

function getMessageRole(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role.toLowerCase() : "";
}

/**
 * Check if a message is a heartbeat prompt (user message containing the heartbeat prompt text).
 */
function isHeartbeatPromptMessage(message: unknown): boolean {
  if (getMessageRole(message) !== "user") {
    return false;
  }
  const text = extractMessageText(message);
  return text.includes(HEARTBEAT_PROMPT);
}

/**
 * Check if a message is a HEARTBEAT_OK response (assistant message that is only HEARTBEAT_OK).
 */
function isHeartbeatOkResponse(message: unknown): boolean {
  const role = getMessageRole(message);
  if (role !== "assistant") {
    return false;
  }
  const text = extractMessageText(message).trim();
  // Match messages that are just HEARTBEAT_OK (possibly with minor whitespace/markup)
  // Strip HTML tags and edge markdown wrappers (including underscores at boundaries),
  // consistent with stripHeartbeatToken() in heartbeat.ts
  const stripped = text
    .replace(/<[^>]*>/g, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "")
    .trim();
  return stripped === HEARTBEAT_TOKEN;
}

/**
 * Filter out HEARTBEAT_OK message pairs (heartbeat prompt + HEARTBEAT_OK response)
 * from chat history. Keeps heartbeat runs that produced actual content (alerts).
 */
export function filterHeartbeatOkMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }

  // Identify indices to remove: heartbeat prompt followed by HEARTBEAT_OK response
  const indicesToRemove = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (isHeartbeatOkResponse(messages[i])) {
      indicesToRemove.add(i);
      // Also remove the preceding heartbeat prompt if present
      if (i > 0 && isHeartbeatPromptMessage(messages[i - 1])) {
        indicesToRemove.add(i - 1);
      }
    }
  }

  if (indicesToRemove.size === 0) {
    return messages;
  }

  return messages.filter((_, index) => !indicesToRemove.has(index));
}
