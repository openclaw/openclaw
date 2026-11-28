import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "./runtime/index.js";
import { isThinkingLikeBlock } from "./thinking-block.js";

type ThoughtSignatureSanitizeOptions = {
  allowBase64Only?: boolean;
  includeCamelCase?: boolean;
};

function isBase64Signature(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const compact = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return false;
  }
  const isUrl = compact.includes("-") || compact.includes("_");
  try {
    const buf = Buffer.from(compact, isUrl ? "base64url" : "base64");
    if (buf.length === 0) {
      return false;
    }
    const encoded = buf.toString(isUrl ? "base64url" : "base64");
    const normalize = (input: string) => input.replace(/[=]+$/g, "");
    return normalize(encoded) === normalize(compact);
  } catch {
    return false;
  }
}

/**
 * Strips Claude-style thought_signature fields from content blocks.
 *
 * Gemini expects thought signatures as base64-encoded bytes, but Claude stores message ids
 * like "msg_abc123...". We only strip "msg_*" to preserve any provider-valid signatures.
 */
export function stripThoughtSignatures<T>(
  content: T,
  options?: ThoughtSignatureSanitizeOptions,
): T {
  if (!Array.isArray(content)) {
    return content;
  }
  const allowBase64Only = options?.allowBase64Only ?? false;
  const includeCamelCase = options?.includeCamelCase ?? false;
  const signatureKeys = ["thought_signature", ...(includeCamelCase ? ["thoughtSignature"] : [])];
  const shouldStripSignature = (value: unknown): boolean => {
    if (!allowBase64Only) {
      return typeof value === "string" && value.startsWith("msg_");
    }
    return typeof value !== "string" || !isBase64Signature(value);
  };
  const sanitized = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const rec = asOptionalObjectRecord(block)!;
    const strippedKeys = signatureKeys.filter((key) => shouldStripSignature(rec[key]));
    if (strippedKeys.length === 0) {
      return block;
    }
    const next = { ...rec };
    for (const key of strippedKeys) {
      delete next[key];
    }
    return next;
  });
  // SAFETY: sanitization preserves the array and block shapes except for the targeted signature fields.
  return sanitized as T;
}

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
