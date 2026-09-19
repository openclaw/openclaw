import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
type AssistantTextBlock = Record<string, unknown> & { type: string; text: string };

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

/** OpenClaw-generated stream-reconciliation ids, not provider item identities. */
export function isGeneratedAssistantTextSignatureId(id: string): boolean {
  return /^(?:minimax-commentary|commentary|final-answer)-\d+-[0-9a-f]{24}$/u.test(id);
}

/** Generated pre-tool commentary ids (ordinary or MiniMax; not final-answer / provider ids). */
function isGeneratedAssistantCommentaryId(id: string): boolean {
  return (
    isGeneratedAssistantTextSignatureId(id) &&
    (id.startsWith("commentary-") || id.startsWith("minimax-commentary-"))
  );
}

/** MiniMax-tagged narration that live Control UI should suppress (not ordinary #135081 progress). */
export function isGeneratedMiniMaxAssistantCommentaryId(id: string): boolean {
  return isGeneratedAssistantCommentaryId(id) && id.startsWith("minimax-commentary-");
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
  let explicitPhase: AssistantPhase | undefined;
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (!isAssistantTextContentBlockType(record.type)) {
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
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as { text?: unknown; content?: unknown; phase?: unknown };
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

  if (!Array.isArray(entry.content)) {
    return undefined;
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
  const finalAnswerText = extractAssistantTextForPhase(message, { phase: "final_answer" });
  if (finalAnswerText) {
    return finalAnswerText;
  }
  return extractAssistantTextForPhase(message);
}

/** Captures authored display sources without making commentary a final reply. */
export function extractAssistantTranscriptSourceText(message: unknown): string | undefined {
  const commentary = extractAssistantTextForPhase(message, { phase: "commentary" });
  const reply = extractAssistantPhaseText(message);
  return commentary && reply ? `${commentary}\n${reply}` : (commentary ?? reply);
}
