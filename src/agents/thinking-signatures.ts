import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "./runtime/index.js";
import { isThinkingLikeBlock } from "./thinking-block.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

function stripThinkingSignaturesFromMessage(message: AssistantMessage): AssistantMessage {
  let changed = false;
  const content = Array.from(message.content, (block) => {
    if (!isThinkingLikeBlock(block)) {
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
export function stripStaleThinkingSignatures<T>(
  messages: T[],
  adapter: {
    role(message: T): string | undefined;
    timestamp(message: T): number | undefined;
    strip(message: T): T;
  },
): T[] {
  let latestCompactionTimestamp: number | null = null;
  for (const message of messages) {
    if (adapter.role(message) !== "compactionSummary") {
      continue;
    }
    const timestamp = adapter.timestamp(message);
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
    const timestamp = adapter.timestamp(message);
    const next =
      adapter.role(message) !== "assistant" ||
      timestamp === undefined ||
      timestamp >= latestCompactionTimestamp
        ? message
        : adapter.strip(message);
    touched ||= next !== message;
    return next;
  });
  return touched ? out : messages;
}

export function stripStaleThinkingSignaturesForCompactionReplay(
  messages: AgentMessage[],
): AgentMessage[] {
  return stripStaleThinkingSignatures(messages, {
    role: (message) => message.role,
    timestamp: (message) => parseDateFirstTimestampMs(message.timestamp),
    strip: (message) =>
      isAssistantMessageWithContent(message)
        ? stripThinkingSignaturesFromMessage(message)
        : message,
  });
}
