import { stripHeartbeatToken } from "./heartbeat.js";

const HEARTBEAT_TASK_PROMPT_PREFIX =
  "Run the following periodic tasks (only those due based on their intervals):";
const HEARTBEAT_TASK_PROMPT_ACK = "After completing all due tasks, reply HEARTBEAT_OK.";

// Matches the "System (untrusted): [timestamp] Exec completed/failed/finished ..." prefix
// written by the heartbeat runner when an async exec event is injected into the session.
// This pattern is unique to heartbeat-injected user messages — real users cannot produce
// the "System (untrusted):" prefix since inbound text sanitization rewrites it.
const EXEC_INJECTION_PREFIX_RE =
  /^System \(untrusted\): \[.+?\] Exec (completed|failed|finished)\b/i;

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

export function isExecEventInjectionMessage(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveMessageText(message.content);
  return EXEC_INJECTION_PREFIX_RE.test(text.trimStart());
}

export function isHeartbeatUserMessage(
  message: { role: string; content?: unknown },
  heartbeatPrompt?: string,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveMessageText(message.content);
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalizedHeartbeatPrompt = heartbeatPrompt?.trim();
  if (normalizedHeartbeatPrompt && trimmed.startsWith(normalizedHeartbeatPrompt)) {
    return true;
  }
  return (
    trimmed.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX) && trimmed.includes(HEARTBEAT_TASK_PROMPT_ACK)
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
  heartbeatPrompt?: string,
): T[] {
  if (messages.length < 2) {
    return messages;
  }

  const result: T[] = [];
  let i = 0;
  while (i < messages.length) {
    if (
      i + 1 < messages.length &&
      isHeartbeatUserMessage(messages[i], heartbeatPrompt) &&
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
