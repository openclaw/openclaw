// Chat message content helpers extract user-visible text from mixed message parts.
import { readStringValue } from "@openclaw/normalization-core/string-coerce";

/** Returns inline string content or the first array text block without scanning later blocks. */
export function extractFirstTextBlock(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  const inline = readStringValue(content);
  if (inline !== undefined) {
    return inline;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const first = content[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  return readStringValue((first as { text?: unknown }).text);
}

export type AssistantPhase = "commentary" | "final_answer";

function isAssistantTextContentBlockType(value: unknown): boolean {
  return value === "text" || value === "input_text" || value === "output_text";
}

/** Narrows unknown phase metadata to assistant text phases that affect visibility. */
export function normalizeAssistantPhase(value: unknown): AssistantPhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

/** Parses assistant text block signatures, preserving legacy raw ids when not JSON encoded. */
export function parseAssistantTextSignature(
  value: unknown,
): { id?: string; phase?: AssistantPhase } | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  if (!value.startsWith("{")) {
    return { id: value };
  }
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown;
      phase?: unknown;
      v?: unknown;
    };
    if (parsed.v !== 1) {
      return null;
    }
    return {
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      ...(normalizeAssistantPhase(parsed.phase)
        ? { phase: normalizeAssistantPhase(parsed.phase) }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Resolves a message phase only when the top-level phase or all explicit blocks agree. */
export function resolveAssistantMessagePhase(message: unknown): AssistantPhase | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as { phase?: unknown; content?: unknown };
  const directPhase = normalizeAssistantPhase(entry.phase);
  if (directPhase) {
    return directPhase;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  const explicitPhases = new Set<AssistantPhase>();
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (!isAssistantTextContentBlockType(record.type)) {
      continue;
    }
    const phase = parseAssistantTextSignature(record.textSignature)?.phase;
    if (phase) {
      explicitPhases.add(phase);
    }
  }
  return explicitPhases.size === 1 ? [...explicitPhases][0] : undefined;
}

/** Finds assistant phase metadata on event payloads that may wrap message-like records. */
export function resolveAssistantEventPhase(data: unknown): AssistantPhase | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as {
    phase?: unknown;
    message?: unknown;
    partial?: unknown;
    item?: unknown;
  };
  return (
    normalizeAssistantPhase(record.phase) ??
    resolveAssistantMessagePhase(record.message) ??
    resolveAssistantMessagePhase(record.partial) ??
    resolveAssistantMessagePhase(record.item) ??
    resolveAssistantMessagePhase(record)
  );
}

/**
 * Detects unphased `text` content blocks that are actually intermediate model
 * monologue rather than user-visible answer text.
 *
 * When a message has interleaved `thinking` content blocks AND multiple
 * unphased `text` blocks, providers like MiniMax-M3 via openai-completions
 * emit internal monologue as plain `text` blocks before the final answer.
 * The native-reasoning seal in the streaming partitioner closes a thought
 * before each visible-text region, but it does not retroactively mark the
 * earlier text region as commentary, so unphased extraction joined every
 * text block and leaked monologue to channels (#96849).
 *
 * Heuristic: an unphased text block T at index i is intermediate monologue
 * when there is a thinking block at j > i AND another text block at k > j.
 * That pattern is the smoking gun: the model emitted text, then thought
 * again, then emitted more text -- the earlier text was internal reasoning
 * that the provider routed through `text` rather than `thinking`. Models
 * that emit a trailing reflective `thinking` block after their final answer
 * do not match this pattern and keep their final text.
 *
 * Callers must pre-compute `hasExplicitPhasedTextBlocks` and short-circuit
 * when true (explicit phase metadata already partitions monologue).
 */
export function isIntermediateMonologueTextBlock(
  content: unknown,
  index: number,
  hasExplicitPhasedTextBlocks: boolean,
): boolean {
  if (hasExplicitPhasedTextBlocks || !Array.isArray(content)) {
    return false;
  }
  let sawThinkingAfter = false;
  for (let j = index + 1; j < content.length; j += 1) {
    const candidate = content[j];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const candidateType = (candidate as { type?: unknown }).type;
    if (candidateType === "thinking" || candidateType === "redacted_thinking") {
      sawThinkingAfter = true;
      continue;
    }
    if (sawThinkingAfter && isAssistantTextContentBlockType(candidateType)) {
      return true;
    }
  }
  return false;
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
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as {
    text?: unknown;
    content?: unknown;
    phase?: unknown;
  };
  const messagePhase = normalizeAssistantPhase(entry.phase);
  const phase = options?.phase;
  const shouldIncludeContent = (resolvedPhase?: AssistantPhase) => {
    if (phase) {
      return resolvedPhase === phase;
    }
    return resolvedPhase === undefined;
  };
  const sanitizeText = options?.sanitizeText;
  const joinWith = options?.joinWith ?? "\n";
  const sanitizeBlockText = (text: string) => (sanitizeText ? sanitizeText(text) : text);
  const normalizeJoinedText = (text: string) => {
    const normalized = text.trim();
    return normalized || undefined;
  };

  if (typeof entry.text === "string") {
    if (!shouldIncludeContent(messagePhase)) {
      return undefined;
    }
    return normalizeJoinedText(sanitizeBlockText(entry.text));
  }

  if (typeof entry.content === "string") {
    if (!shouldIncludeContent(messagePhase)) {
      return undefined;
    }
    return normalizeJoinedText(sanitizeBlockText(entry.content));
  }

  if (!Array.isArray(entry.content)) {
    return undefined;
  }

  const hasExplicitPhasedTextBlocks = entry.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (!isAssistantTextContentBlockType(record.type)) {
      return false;
    }
    return Boolean(parseAssistantTextSignature(record.textSignature)?.phase);
  });

  // Once explicit phased blocks exist, unphased extraction should not revive legacy text.
  if (!phase && hasExplicitPhasedTextBlocks) {
    return undefined;
  }

  const isIntermediateMonologueTextIndex = (index: number): boolean =>
    isIntermediateMonologueTextBlock(entry.content, index, hasExplicitPhasedTextBlocks);

  const parts = entry.content
    .map((block, index) => {
      if (!block || typeof block !== "object") {
        return null;
      }
      const record = block as {
        type?: unknown;
        text?: unknown;
        textSignature?: unknown;
      };
      if (!isAssistantTextContentBlockType(record.type) || typeof record.text !== "string") {
        return null;
      }
      const signature = parseAssistantTextSignature(record.textSignature);
      const resolvedPhase =
        signature?.phase ?? (hasExplicitPhasedTextBlocks ? undefined : messagePhase);
      if (!shouldIncludeContent(resolvedPhase)) {
        return null;
      }
      // Drop unphased text blocks identified as intermediate monologue.
      if (!signature?.phase && isIntermediateMonologueTextIndex(index)) {
        return null;
      }
      const sanitized = sanitizeBlockText(record.text);
      return sanitized.trim() ? sanitized : null;
    })
    .filter((value): value is string => typeof value === "string");

  if (parts.length === 0) {
    return undefined;
  }
  return normalizeJoinedText(parts.join(joinWith));
}

/** Returns user-visible assistant text, preferring final answers over legacy unphased text. */
export function extractAssistantVisibleText(message: unknown): string | undefined {
  const finalAnswerText = extractAssistantTextForPhase(message, {
    phase: "final_answer",
  });
  if (finalAnswerText) {
    return finalAnswerText;
  }
  return extractAssistantTextForPhase(message);
}
