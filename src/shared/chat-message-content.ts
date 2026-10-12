import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";

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

function isAssistantTextContentBlockType(value: unknown): boolean {
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
      result =
        parsed.v === 1
          ? {
              ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
              ...(normalizeAssistantPhase(parsed.phase)
                ? { phase: normalizeAssistantPhase(parsed.phase) }
                : {}),
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
  options?: {
    phase?: AssistantPhase;
    sanitizeText?: (text: string) => string;
    joinWith?: string;
  },
): string | undefined {
  const entry = asOptionalObjectRecord(message);
  if (!entry) {
    return undefined;
  }
  const messagePhase = normalizeAssistantPhase(entry.phase);
  const phase = options?.phase;
  const sanitizeText = options?.sanitizeText;
  const joinWith = options?.joinWith ?? "\n";
  const sanitizeBlockText = (text: string) => (sanitizeText ? sanitizeText(text) : text);
  const inlineText = typeof entry.text === "string" ? entry.text : entry.content;
  if (typeof inlineText === "string") {
    const text = messagePhase === phase ? sanitizeBlockText(inlineText) : undefined;
    return text?.trim() ? text : undefined;
  }

  const parts: string[] = [];
  for (const block of readAssistantTextBlocksForPhase(message, phase)) {
    const sanitized = sanitizeBlockText(block.text);
    if (sanitized.trim()) {
      parts.push(sanitized);
    }
  }
  return parts.length ? parts.join(joinWith) : undefined;
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
