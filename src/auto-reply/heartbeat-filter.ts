import { stripHeartbeatToken } from "./heartbeat.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

function resolveMessageText(content: unknown): { text: string; hasNonTextContent: boolean } {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content != null };
  }
  let hasNonTextContent = false;
  const text = content
    .filter((block): block is { type: "text"; text: string } => {
      if (typeof block !== "object" || block === null || !("type" in block)) {
        hasNonTextContent = true;
        return false;
      }
      if (block.type !== "text") {
        hasNonTextContent = true;
        return false;
      }
      if (typeof (block as { text?: unknown }).text !== "string") {
        hasNonTextContent = true;
        return false;
      }
      return true;
    })
    .map((block) => block.text)
    .join("");
  return { text, hasNonTextContent };
}

export function isHeartbeatUserMessage(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveMessageText(message.content);
  return (
    text.includes(HEARTBEAT_TOKEN) &&
    /(?:reply|respond|return|say|output|answer)\s+(?:with\s+)?HEARTBEAT_OK/i.test(text)
  );
}

export function isHeartbeatOkResponse(
  message: { role: string; content?: unknown },
  ackMaxChars?: number,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  return stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars: ackMaxChars }).shouldSkip;
}

export function filterHeartbeatPairs<T extends { role: string; content?: unknown }>(
  messages: T[],
  ackMaxChars?: number,
): T[] {
  if (messages.length < 2) {
    return messages;
  }

  const result: T[] = [];
  let i = 0;
  while (i < messages.length) {
    if (
      i + 1 < messages.length &&
      isHeartbeatUserMessage(messages[i]) &&
      isHeartbeatOkResponse(messages[i + 1], ackMaxChars)
    ) {
      i += 2;
      continue;
    }
    result.push(messages[i]);
    i++;
  }

  return result;
}
