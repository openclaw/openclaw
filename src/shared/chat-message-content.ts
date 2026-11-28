import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { hasAnyNonEmptyString as hasNonEmptyStringArray } from "../agents/delivery-evidence-values.js";
import { stripMixedSilentReplyTokens } from "../auto-reply/reply/mixed-silent-reply-tokens.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { hasPersistedMedia } from "../sessions/user-turn-media.js";

/** Returns inline string content or the first array text block without scanning later blocks. */
export function extractFirstTextBlock(message: unknown): string | undefined {
  const content = asOptionalObjectRecord(message)?.content;
  const inline = readStringValue(content);
  if (inline !== undefined) {
    return inline;
  }
  return Array.isArray(content)
    ? readStringValue(asOptionalObjectRecord(content[0])?.text)
    : undefined;
}

export type AssistantPhase = "commentary" | "final_answer";
type AssistantTextBlock = AssistantTextSignatureBlock &
  Record<string, unknown> & { type: string; text: string };

type AssistantTextSignature = { id?: string; phase?: AssistantPhase } | null;
type AssistantTextSignatureBlock = { textSignature?: unknown };

// Provider partials mutate blocks in place. Pair the stable block identity with
// its current signature text so a replacement can never reuse a stale parse.
const assistantTextSignatureCache = new WeakMap<
  object,
  { text: unknown; result: AssistantTextSignature }
>();

export function isAssistantTextContentBlockType(value: unknown): boolean {
  return value === "text" || value === "input_text" || value === "output_text";
}

/** Narrows unknown phase metadata to assistant text phases that affect visibility. */
export function normalizeAssistantPhase(value: unknown): AssistantPhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

/** Parses assistant text block signatures, preserving legacy raw ids when not JSON encoded. */
export function parseAssistantTextSignature(
  block: AssistantTextSignatureBlock,
): AssistantTextSignature {
  const value = block.textSignature;
  const cached = assistantTextSignatureCache.get(block);
  if (cached && cached.text === value) {
    return cached.result;
  }
  let result: AssistantTextSignature;
  if (typeof value !== "string" || value.trim().length === 0) {
    result = null;
  } else if (!value.startsWith("{")) {
    result = { id: value };
  } else {
    try {
      const parsed = JSON.parse(value) as { id?: unknown; phase?: unknown; v?: unknown };
      const phase = normalizeAssistantPhase(parsed.phase);
      result =
        parsed.v === 1
          ? {
              ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
              ...(phase ? { phase } : {}),
            }
          : null;
    } catch {
      result = null;
    }
  }
  assistantTextSignatureCache.set(block, { text: value, result });
  return result;
}

/** Resolves a message phase only when the top-level phase or all explicit blocks agree. */
export function resolveAssistantMessagePhase(message: unknown): AssistantPhase | undefined {
  const entry = asOptionalObjectRecord(message);
  if (!entry) {
    return undefined;
  }
  const directPhase = normalizeAssistantPhase(entry.phase);
  if (directPhase) {
    return directPhase;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  let explicitPhase: AssistantPhase | undefined;
  for (const block of entry.content) {
    const record = asOptionalObjectRecord(block);
    if (!record || !isAssistantTextContentBlockType(record.type)) {
      continue;
    }
    const phase = parseAssistantTextSignature(record)?.phase;
    if (phase) {
      if (explicitPhase && explicitPhase !== phase) {
        return undefined;
      }
      explicitPhase = phase;
    }
  }
  return explicitPhase;
}

/** Finds assistant phase metadata on event payloads that may wrap message-like records. */
export function resolveAssistantEventPhase(data: unknown): AssistantPhase | undefined {
  const record = asOptionalObjectRecord(data);
  if (!record) {
    return undefined;
  }
  return (
    normalizeAssistantPhase(record.phase) ??
    resolveAssistantMessagePhase(record.message) ??
    resolveAssistantMessagePhase(record.partial) ??
    resolveAssistantMessagePhase(record.item) ??
    resolveAssistantMessagePhase(record)
  );
}

/** Selects original text blocks with the same explicit-phase precedence used for delivery. */
export function readAssistantTextBlocksForPhase(
  message: unknown,
  phase?: AssistantPhase,
): AssistantTextBlock[] {
  const entry = asOptionalRecord(message);
  if (!Array.isArray(entry?.content)) {
    return [];
  }
  const hasExplicitPhases = entry.content.some((value) => {
    const block = asOptionalRecord(value);
    return Boolean(
      block &&
      isAssistantTextContentBlockType(block.type) &&
      parseAssistantTextSignature(block)?.phase,
    );
  });
  if (!phase && hasExplicitPhases) {
    return [];
  }
  const messagePhase = hasExplicitPhases ? undefined : normalizeAssistantPhase(entry.phase);
  return entry.content.filter((value): value is AssistantTextBlock => {
    const block = asOptionalRecord(value);
    return Boolean(
      block &&
      isAssistantTextContentBlockType(block.type) &&
      typeof block.text === "string" &&
      (parseAssistantTextSignature(block)?.phase ?? messagePhase) === phase,
    );
  });
}

/** Extracts assistant text for a requested phase without mixing legacy and explicitly phased text. */
export function extractAssistantTextForPhase(
  message: unknown,
  options?: { phase?: AssistantPhase },
): string | undefined {
  const entry = asOptionalObjectRecord(message);
  if (!entry) {
    return undefined;
  }
  const messagePhase = normalizeAssistantPhase(entry.phase);
  const phase = options?.phase;
  const inlineText = typeof entry.text === "string" ? entry.text : entry.content;
  if (typeof inlineText === "string") {
    const text = messagePhase === phase ? inlineText : undefined;
    return text?.trim() ? text : undefined;
  }

  const parts: string[] = [];
  for (const block of readAssistantTextBlocksForPhase(message, phase)) {
    if (block.text.trim()) {
      parts.push(block.text);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

/** Returns user-visible assistant text, preferring final answers over legacy unphased text. */
export function extractAssistantPhaseText(message: unknown): string | undefined {
  return (
    extractAssistantTextForPhase(message, { phase: "final_answer" }) ??
    extractAssistantTextForPhase(message)
  );
}

/** Captures authored display sources without making commentary a final reply. */
export function extractAssistantTranscriptSourceText(message: unknown): string | undefined {
  const commentary = extractAssistantTextForPhase(message, { phase: "commentary" });
  const reply = extractAssistantPhaseText(message);
  return commentary && reply ? `${commentary}\n${reply}` : (commentary ?? reply);
}

export function readTerminalSourceReplyDeliveryMirror(
  message: unknown,
): { sourceTurnId: string; toolCallId?: string } | undefined {
  const delivery = asOptionalObjectRecord(asOptionalObjectRecord(message)?.openclawDeliveryMirror);
  if (!delivery) {
    return undefined;
  }
  const sourceTurnId =
    typeof delivery.sourceTurnId === "string" ? delivery.sourceTurnId.trim() : "";
  if (delivery.kind !== "message-tool-source-reply" || delivery.final !== true || !sourceTurnId) {
    return undefined;
  }
  const toolCallId = typeof delivery.toolCallId === "string" ? delivery.toolCallId.trim() : "";
  return { sourceTurnId, ...(toolCallId ? { toolCallId } : {}) };
}

export type AssistantSilenceBlockFact = {
  ignored: boolean;
  text?: string | null;
  phase?: AssistantPhase;
  explicitPhase: boolean;
};

/** Only a bounded control-token fragment survives; arbitrary reply text does not. */
export function collectAssistantSilenceBlockFact(value: unknown): AssistantSilenceBlockFact {
  const block = asOptionalRecord(value);
  const textType = isAssistantTextContentBlockType(block?.type);
  const phase = textType && block ? parseAssistantTextSignature(block)?.phase : undefined;
  const text = textType && typeof block?.text === "string" ? block.text : undefined;
  const trimmed = text?.trim().toUpperCase();
  return {
    ignored:
      block?.type === "thinking" ||
      block?.type === "reasoning" ||
      block?.type === "redacted_thinking",
    text:
      text === undefined
        ? undefined
        : !SILENT_REPLY_TOKEN.includes(trimmed!)
          ? null
          : `${text.trimStart() === text ? "" : " "}${trimmed}${text.trimEnd() === text ? "" : " "}`,
    phase,
    explicitPhase: Boolean(phase),
  };
}

export function assistantSilenceOverride(message: unknown): boolean | undefined {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant") {
    return false;
  }
  if (record.display === false) {
    return true;
  }
  if (
    record.display === true ||
    readTerminalSourceReplyDeliveryMirror(message) ||
    hasPersistedMedia(message) ||
    hasNonEmptyStringArray(asOptionalRecord(record.openclawDelivery)?.mediaUrls)
  ) {
    return false;
  }
  const inline = typeof record.text === "string" ? record.text : record.content;
  return typeof inline === "string" ? isSilentReplyText(inline) : undefined;
}

export function isSilentAssistantFromFacts(
  override: boolean | undefined,
  blocks: readonly AssistantSilenceBlockFact[] | undefined,
  phase?: AssistantPhase,
): boolean {
  if (override !== undefined) {
    return override;
  }
  if (!blocks) {
    return false;
  }
  if (blocks.some((block) => !block.ignored && block.text === undefined)) {
    return false;
  }
  const explicit = blocks.some((block) => block.explicitPhase);
  const final = blocks.filter(
    (block) =>
      block.text !== undefined &&
      (block.phase ?? (explicit ? undefined : phase)) === "final_answer",
  );
  const selected = final.length > 0 ? final : blocks.filter((block) => !block.ignored);
  return (
    !selected.some((block) => block.text === null) &&
    isSilentReplyText(selected.map((block) => block.text).join(""))
  );
}

/** Classifies raw assistant rows after their persisted visibility facts. */
export function isSilentAssistantTranscriptMessage(message: unknown): boolean {
  const record = asOptionalObjectRecord(message);
  return isSilentAssistantFromFacts(
    assistantSilenceOverride(message),
    Array.isArray(record?.content)
      ? record.content.map(collectAssistantSilenceBlockFact)
      : undefined,
    normalizeAssistantPhase(record?.phase),
  );
}

/** Applies raw stored-row visibility before preparing one leading silence line. */
export function prepareAssistantTranscriptText(
  message: unknown,
  text: string | undefined,
): string | undefined {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant") {
    return text;
  }
  if (isSilentAssistantTranscriptMessage(message)) {
    return undefined;
  }
  return record.display !== true &&
    !readTerminalSourceReplyDeliveryMirror(message) &&
    text !== undefined
    ? (stripMixedSilentReplyTokens(text) ?? text)
    : text;
}
