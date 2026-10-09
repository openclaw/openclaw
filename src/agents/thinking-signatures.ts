import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "./runtime/index.js";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

export function isThinkingBlock(block: AssistantContentBlock): boolean {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    ((block as { type?: unknown }).type === "thinking" ||
      (block as { type?: unknown }).type === "redacted_thinking")
  );
}

function stripThinkingSignaturesFromMessage(message: AssistantMessage): AssistantMessage {
  let changed = false;
  const content = Array.from(message.content, (block) => {
    if (!isThinkingBlock(block)) {
      return block;
    }
    const signatureFields = ["thinkingSignature", "signature", "thought_signature"];
    const type: unknown = Reflect.get(block, "type");
    // data is the signature payload for redacted_thinking blocks.
    if (type === "redacted_thinking") {
      signatureFields.push("data");
    }
    if (!signatureFields.some((field) => Reflect.get(block, field) != null)) {
      return block;
    }
    const stripped = { ...block };
    for (const field of signatureFields) {
      Reflect.deleteProperty(stripped, field);
    }
    changed = true;
    return stripped;
  });
  return changed ? { ...message, content } : message;
}

/**
 * Strip signatures from assistant messages generated before the latest compaction.
 * Their signatures are bound to the replaced prompt prefix and cannot be replayed.
 */
export function stripStaleThinkingSignaturesForCompactionReplay(
  messages: AgentMessage[],
): AgentMessage[] {
  let latestCompactionTimestamp: number | null = null;
  for (const message of messages) {
    if (message.role !== "compactionSummary") {
      continue;
    }
    const timestamp = parseDateFirstTimestampMs(message.timestamp);
    if (timestamp !== undefined) {
      latestCompactionTimestamp =
        latestCompactionTimestamp === null
          ? timestamp
          : Math.max(latestCompactionTimestamp, timestamp);
    }
  }
  if (latestCompactionTimestamp === null) {
    return messages;
  }

  let touched = false;
  const out = messages.map((message) => {
    if (!isAssistantMessageWithContent(message)) {
      return message;
    }
    const timestamp = parseDateFirstTimestampMs(message.timestamp);
    if (timestamp === undefined || timestamp >= latestCompactionTimestamp) {
      return message;
    }
    const stripped = stripThinkingSignaturesFromMessage(message);
    touched ||= stripped !== message;
    return stripped;
  });
  return touched ? out : messages;
}
