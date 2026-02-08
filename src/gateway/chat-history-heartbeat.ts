import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";

type HistoryMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

/**
 * Extract the plain-text body from a transcript message (string or content array).
 */
function extractMessageText(msg: HistoryMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("\n");
  }
  return "";
}

/**
 * Returns true when the message is an assistant reply whose text is effectively
 * just the HEARTBEAT_OK token (with optional surrounding whitespace / markup).
 */
export function isHeartbeatOkMessage(msg: unknown): boolean {
  const m = msg as HistoryMessage;
  if (m?.role !== "assistant") {
    return false;
  }
  const text = extractMessageText(m).trim();
  if (!text) {
    return false;
  }
  // Strip lightweight markup wrappers (bold, code, etc.) that some models add.
  const stripped = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "")
    .trim();
  return stripped === HEARTBEAT_TOKEN;
}

/**
 * Filter heartbeat exchanges from chat history messages.
 *
 * When `showOk` is false (the default for webchat), removes:
 *   1. Assistant messages that are just "HEARTBEAT_OK"
 *   2. The immediately preceding user message if it looks like a heartbeat prompt
 *      (contains "HEARTBEAT_OK" — the standard prompt asks the agent to
 *       "reply HEARTBEAT_OK")
 */
export function filterHeartbeatMessages(messages: unknown[]): unknown[] {
  // Walk backwards so we can pair assistant HEARTBEAT_OK with its prompt.
  const excluded = new Set<number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isHeartbeatOkMessage(messages[i])) {
      continue;
    }
    excluded.add(i);
    // Check if the previous message is the heartbeat prompt.
    if (i > 0) {
      const prev = messages[i - 1] as HistoryMessage;
      if (prev?.role === "user") {
        const text = extractMessageText(prev);
        if (text.includes(HEARTBEAT_TOKEN)) {
          excluded.add(i - 1);
        }
      }
    }
  }
  if (excluded.size === 0) {
    return messages;
  }
  return messages.filter((_, idx) => !excluded.has(idx));
}
