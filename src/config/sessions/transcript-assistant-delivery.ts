import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantDeliveryTtsFacts, AssistantMessage } from "../../llm/types.js";
import {
  extractAssistantPhaseText,
  readAssistantTextBlocksForPhase,
} from "../../shared/chat-message-content.js";
import { createTextPartCodeRegionResolver } from "../../shared/text/code-regions.js";
import { trimTextPreservingCode } from "../../shared/text/text-projection.js";
import { extractTtsDirectiveParts } from "../../tts/directive-facts.js";
import {
  parseInlineDirectiveParts,
  stripInlineDirectivePartsForDelivery,
} from "../../utils/directive-tags.js";
import type { LatestTranscriptAssistantText } from "./session-accessor.types.js";

type AssistantDirectiveMessage = {
  content?: unknown;
  openclawDelivery?: unknown;
  role?: unknown;
};

type AssistantDeliveryFacts = NonNullable<AssistantMessage["openclawDelivery"]>;

/** Turn-owned display preparation; source text precedes transcript-only hook rewrites. */
export type PrepareAssistantTranscriptMessage = (
  message: AssistantMessage,
  sourceText: string | undefined,
) => AssistantMessage;

/** Record display ownership without rewriting bytes used by runtime transcript identity. */
export function recordAssistantManagedMediaUrls<T extends AssistantDirectiveMessage>(
  message: T,
  urls: readonly string[] | undefined,
): T {
  const mediaUrls = Array.from(new Set(urls?.map((url) => url.trim()).filter(Boolean) ?? []));
  if (message.role === "assistant" && mediaUrls.length > 0) {
    Object.assign(message, {
      openclawDelivery: {
        ...(isRecord(message.openclawDelivery) ? message.openclawDelivery : {}),
        mediaUrls,
      },
    });
  }
  return message;
}

function mergeTtsFacts(
  current: AssistantDeliveryTtsFacts | undefined,
  next: AssistantDeliveryTtsFacts,
): AssistantDeliveryTtsFacts {
  return {
    tagged: true,
    ...((current?.text ?? next.text) != null ? { text: current?.text ?? next.text } : {}),
    ...(current?.directives || next.directives
      ? { directives: [...(current?.directives ?? []), ...(next.directives ?? [])] }
      : {}),
  };
}

/** Strips final-answer directives in place so live state and persisted bytes stay identical. */
// TRANSITIONAL(marker-retirement): once the visibleReplies default flips and the
// model stops emitting inline markers, this projection parses nothing and the
// whole applier (plus its parser imports) can be deleted; openclawDelivery facts
// then come exclusively from structured message-tool sends and managed-media rewrites.
export function applyAssistantDeliveryDirectives<T extends AssistantDirectiveMessage>(
  message: T,
  options?: { managedMediaUrls?: readonly string[] },
): T {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  const finalBlocks = readAssistantTextBlocksForPhase(message, "final_answer");
  const blocks = finalBlocks.length ? finalBlocks : readAssistantTextBlocksForPhase(message);
  const original = blocks.map((block) => block.text);
  const parsed = parseInlineDirectiveParts(original);
  const stripped = stripInlineDirectivePartsForDelivery(parsed.map((part) => part.text));
  const tts = extractTtsDirectiveParts(stripped.map((part) => part.text));
  const codeRegions =
    blocks.length > 1
      ? createTextPartCodeRegionResolver(tts.map((part) => part.cleanedText))
      : undefined;
  let facts: AssistantDeliveryFacts | undefined;
  for (const [index, block] of blocks.entries()) {
    const reply = expectDefined(parsed[index], "parsed assistant part");
    const speech = expectDefined(tts[index], "prepared assistant speech part");
    const hasDeliveryFacts = reply.hasAudioTag || reply.hasReplyTag || Boolean(speech.facts);
    if (speech.cleanedText === original[index] && !hasDeliveryFacts) {
      continue;
    }
    block.text = speech.facts
      ? trimTextPreservingCode(speech.cleanedText, "both", codeRegions?.(index))
      : speech.cleanedText;
    if (!hasDeliveryFacts) {
      continue;
    }
    facts ??= {};
    Object.assign(facts, {
      ...(reply.audioAsVoice ? { audioAsVoice: true as const } : {}),
      ...(reply.replyToCurrent ? { replyToCurrent: true as const } : {}),
      ...(reply.replyToExplicitId ? { replyToId: reply.replyToExplicitId } : {}),
      ...(speech.facts ? { tts: mergeTtsFacts(facts.tts, speech.facts) } : {}),
    });
  }
  if (facts) {
    const currentFacts = isRecord(message.openclawDelivery) ? message.openclawDelivery : undefined;
    const mergedFacts = { ...currentFacts, ...facts };
    if (facts.replyToId) {
      delete mergedFacts.replyToCurrent;
    } else if (facts.replyToCurrent) {
      delete mergedFacts.replyToId;
    }
    Object.assign(message, { openclawDelivery: mergedFacts });
  }
  return recordAssistantManagedMediaUrls(message, options?.managedMediaUrls);
}

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
