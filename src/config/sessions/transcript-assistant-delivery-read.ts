import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantDeliveryTtsFacts, AssistantMessage } from "../../llm/types.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import type { LatestTranscriptAssistantText } from "./session-accessor.types.js";

type AssistantDeliveryFacts = NonNullable<AssistantMessage["openclawDelivery"]>;

/** Decode only persisted delivery facts; transcript records cannot supply runtime authority. */
function readAssistantDeliveryFacts(value: unknown): AssistantDeliveryFacts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const facts: AssistantDeliveryFacts = {};
  if (value.audioAsVoice === true) {
    facts.audioAsVoice = true;
  }
  if (typeof value.replyToId === "string" && value.replyToId.trim()) {
    facts.replyToId = value.replyToId;
  } else if (value.replyToCurrent === true) {
    facts.replyToCurrent = true;
  }
  if (Array.isArray(value.mediaUrls)) {
    const mediaUrls = value.mediaUrls.filter(
      (url): url is string => typeof url === "string" && url.trim().length > 0,
    );
    if (mediaUrls.length) {
      facts.mediaUrls = mediaUrls;
    }
  }
  if (value.textPhaseRequiresTerminal === true) {
    facts.textPhaseRequiresTerminal = true;
  }
  if (isRecord(value.tts) && value.tts.tagged === true) {
    const tts: AssistantDeliveryTtsFacts = { tagged: true };
    if (typeof value.tts.text === "string") {
      tts.text = value.tts.text;
    }
    if (Array.isArray(value.tts.directives)) {
      tts.directives = value.tts.directives.flatMap((directive) => {
        if (!isRecord(directive) || !isRecord(directive.values)) {
          return [];
        }
        const entries = Object.entries(directive.values);
        if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
          return [];
        }
        const values = Object.fromEntries(entries);
        return [
          {
            ...(typeof directive.provider === "string" ? { provider: directive.provider } : {}),
            values,
          },
        ];
      });
    }
    facts.tts = tts;
  }
  return Object.keys(facts).length ? facts : undefined;
}

/** SQLite and retained JSONL readers expose the same authored text and delivery facts. */
export function projectAssistantTranscriptText(
  message: unknown,
  id?: unknown,
): LatestTranscriptAssistantText | undefined {
  if (!isRecord(message) || message.role !== "assistant") {
    return undefined;
  }
  const text = extractAssistantPhaseText(message);
  if (!text?.trim()) {
    return undefined;
  }
  const openclawDelivery = readAssistantDeliveryFacts(message.openclawDelivery);
  return {
    ...(typeof id === "string" && id ? { id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
    ...(openclawDelivery ? { openclawDelivery } : {}),
  };
}
