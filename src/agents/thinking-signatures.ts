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

function stripSignatureFieldsFromThinkingBlock(
  block: AssistantContentBlock,
): AssistantContentBlock {
  const stripped = { ...block };
  Reflect.deleteProperty(stripped, "thinkingSignature");
  Reflect.deleteProperty(stripped, "signature");
  Reflect.deleteProperty(stripped, "thought_signature");
  // data is the signature payload for redacted_thinking blocks
  const type: unknown = Reflect.get(block, "type");
  if (type === "redacted_thinking") {
    Reflect.deleteProperty(stripped, "data");
  }
  return stripped;
}

function stripThinkingSignaturesFromMessage(message: AgentMessage): AgentMessage {
  if (!isAssistantMessageWithContent(message)) {
    return message;
  }
  let changed = false;
  const newContent: AssistantContentBlock[] = [];
  for (const block of message.content) {
    if (!isThinkingBlock(block)) {
      newContent.push(block);
      continue;
    }
    const type: unknown = Reflect.get(block, "type");
    const hasSignature =
      Reflect.get(block, "thinkingSignature") != null ||
      Reflect.get(block, "signature") != null ||
      Reflect.get(block, "thought_signature") != null ||
      (type === "redacted_thinking" && Reflect.get(block, "data") != null);
    if (!hasSignature) {
      newContent.push(block);
      continue;
    }
    newContent.push(stripSignatureFieldsFromThinkingBlock(block));
    changed = true;
  }
  return changed ? { ...message, content: newContent } : message;
}

const OPAQUE_SIGNATURE_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * A replayable signature is an opaque provider token: non-empty, untrimmed-safe,
 * and base64/base64url. Anything else (most importantly a value carrying the "…"
 * mask marker left by secret redaction) can never validate at the provider and
 * makes every later replay of the session fail with a hard 400.
 */
export function isReplayableThinkingSignature(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\u2026") &&
    OPAQUE_SIGNATURE_RE.test(value)
  );
}

function hasUnreplayableSignature(block: AssistantContentBlock): boolean {
  const type: unknown = Reflect.get(block, "type");
  for (const key of ["thinkingSignature", "signature", "thought_signature"]) {
    const value = Reflect.get(block, key);
    if (value != null && !isReplayableThinkingSignature(value)) {
      return true;
    }
  }
  if (type === "redacted_thinking") {
    const data = Reflect.get(block, "data");
    if (data != null && !isReplayableThinkingSignature(data)) {
      return true;
    }
  }
  return false;
}

/**
 * Drop signatures that cannot possibly be replayed (corrupt or mask-damaged).
 * The thinking text is preserved as an unsigned block, matching the existing
 * missing/blank-signature policy. Without this a single corrupted signature
 * wedges the session forever, because the stored transcript replays unchanged.
 */
export function stripUnreplayableThinkingSignatures(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out = messages.map((message) => {
    if (!isAssistantMessageWithContent(message)) {
      return message;
    }
    let changed = false;
    const newContent = message.content.map((block) => {
      if (!isThinkingBlock(block) || !hasUnreplayableSignature(block)) {
        return block;
      }
      changed = true;
      return stripSignatureFieldsFromThinkingBlock(block);
    });
    if (!changed) {
      return message;
    }
    touched = true;
    return { ...message, content: newContent };
  });
  return touched ? out : messages;
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
