import type { SignalMention } from "./event-handler.types.js";

const OBJECT_REPLACEMENT = "\uFFFC";

function isValidMention(mention: SignalMention | null | undefined): mention is SignalMention {
  if (!mention) {
    return false;
  }
  if (!(mention.uuid || mention.number)) {
    return false;
  }
  if (typeof mention.start !== "number" || Number.isNaN(mention.start)) {
    return false;
  }
  if (typeof mention.length !== "number" || Number.isNaN(mention.length)) {
    return false;
  }
  return mention.length > 0;
}

function clampBounds(start: number, length: number, textLength: number) {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeLength = Math.max(0, Math.trunc(length));
  const safeEnd = Math.min(textLength, safeStart + safeLength);
  return { start: safeStart, end: safeEnd };
}

export interface MentionRenderResult {
  text: string;
  /**
   * Map from original character offset to cumulative shift caused by mention expansions.
   * Used to adjust textStyle ranges that reference the original message offsets.
   */
  offsetShifts: Map<number, number>;
}

export function renderSignalMentions(
  message: string,
  mentions?: SignalMention[] | null,
): MentionRenderResult {
  if (!message || !mentions?.length) {
    return { text: message, offsetShifts: new Map() };
  }

  let normalized = message;
  const offsetShifts = new Map<number, number>();
  // Process mentions in reverse order (sorted by descending start position)
  // to avoid having to recalculate positions as we insert text
  const candidates = mentions.filter(isValidMention).toSorted((a, b) => b.start! - a.start!);

  for (const mention of candidates) {
    const identifier = mention.uuid ?? mention.number;
    if (!identifier) {
      continue;
    }

    const { start, end } = clampBounds(mention.start!, mention.length!, normalized.length);
    if (start >= end) {
      continue;
    }
    const slice = normalized.slice(start, end);

    if (!slice.includes(OBJECT_REPLACEMENT)) {
      continue;
    }

    const replacement = `@${identifier}`;
    const originalLength = end - start;
    const newLength = replacement.length;
    const shift = newLength - originalLength;

    normalized = normalized.slice(0, start) + replacement + normalized.slice(end);

    // Track the shift at this position
    if (shift !== 0) {
      offsetShifts.set(start, shift);
    }
  }

  return { text: normalized, offsetShifts };
}
