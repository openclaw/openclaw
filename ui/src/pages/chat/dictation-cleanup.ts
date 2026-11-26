/** Private, local-only dictation transform. Publication remains with the composer owner. */
export type CleanupPolicy = {
  readonly version: 1;
  readonly mode: "off" | "conservative";
  readonly locale?: string | null;
};

/** Half-open UTF-16 offsets into the immutable recognizer source. */
export type CleanupRange = { readonly start: number; readonly end: number };
export type CleanupToken = CleanupRange & {
  readonly confidence?: number;
  readonly startTimeMs?: number;
  readonly endTimeMs?: number;
};
export type DictationCleanupSource = {
  readonly id: string;
  readonly revision: number;
  readonly text: string;
  readonly isFinal: boolean;
  readonly locale?: string | null;
  readonly protectedSpans?: readonly CleanupRange[];
  /** Only recognizer-supplied metadata belongs here; omission is supported. */
  readonly tokens?: readonly CleanupToken[];
};
export type CleanupRemoval = CleanupRange & {
  readonly category: "hesitation" | "exact_restart";
  readonly evidence: "text" | "text-and-provider-metadata";
};
export type CleanupSourceMap = {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly candidateStart: number;
  readonly candidateEnd: number;
};
export type CleanupReason =
  | "off"
  | "not-final"
  | "unsupported-policy"
  | "unsupported-locale"
  | "input-limit"
  | "invalid-source"
  | "ambiguous-context"
  | "invalid-plan"
  | "stale-plan"
  | "protected-text"
  | "low-confidence"
  | "unsafe-removal";
export type CleanupResult = {
  readonly sourceId: string;
  readonly revision: number;
  readonly raw: string;
  readonly candidate: string;
  readonly removals: readonly CleanupRemoval[];
  readonly status: "unchanged" | "refined" | "retained" | "rejected";
  readonly reason?: CleanupReason;
  readonly sourceMap: readonly CleanupSourceMap[];
};

const MAX_SOURCE_BYTES = 32 * 1024;
const MAX_METADATA_RANGES = 4096;
const MAX_REMOVALS = 64;
export function isCleanupSourceBounded(text: string): boolean {
  return (
    text.length <= MAX_SOURCE_BYTES && new TextEncoder().encode(text).length <= MAX_SOURCE_BYTES
  );
}
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const hesitationPrefix = /^(?:um|uh)(?:,[ \t]+|[ \t]+)/;
const restartPrefix = /^I[ \t]+(?=I[ \t]+)/;
// These small constructions are deliberately narrower than an English filler blacklist.
const continuation =
  /^(?:please[ \t]+(?:call|send|bring|schedule|remind|show|save|check)\b|I[ \t]+(?:I[ \t]+)?(?:need|want|have|will|would[ \t]+like)\b)/;
const correctionEvidence =
  /\b(?:no|sorry|actually|rather|instead|correction|correcting)\b|\bI[ \t]+mean\b/i;
const literalEvidence =
  /["“”`]|(?:^|\W)'|'(?:\W|$)|\b(?:quote|unquote|word|words|letter|letters|spell|spelled|identifier|variable|project|named|lyrics|code|repeat)\b|\w[_/\\@]\w|https?:/i;

function retained(
  source: DictationCleanupSource,
  status: CleanupResult["status"],
  reason?: CleanupReason,
): CleanupResult {
  return {
    sourceId: source.id,
    revision: source.revision,
    raw: source.text,
    candidate: source.text,
    removals: [],
    status,
    reason,
    sourceMap: [
      {
        sourceStart: 0,
        sourceEnd: source.text.length,
        candidateStart: 0,
        candidateEnd: source.text.length,
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRange(value: unknown, length: number): value is CleanupRange {
  return (
    isRecord(value) &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    value.start >= 0 &&
    value.end > value.start &&
    value.end <= length
  );
}

function overlaps(a: CleanupRange, b: CleanupRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function sourceReason(
  source: DictationCleanupSource,
  policy: CleanupPolicy,
): CleanupReason | undefined {
  if (policy.version !== 1 || (policy.mode !== "off" && policy.mode !== "conservative")) {
    return "unsupported-policy";
  }
  if (policy.mode === "off") {
    return "off";
  }
  if (!source.isFinal) {
    return "not-final";
  }
  const locale = source.locale ?? policy.locale;
  if (!locale || !/^en(?:-[a-z0-9]+)*$/i.test(locale)) {
    return "unsupported-locale";
  }
  if (!isCleanupSourceBounded(source.text)) {
    return "input-limit";
  }
  if (
    !source.id ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0 ||
    (source.protectedSpans?.length ?? 0) > MAX_METADATA_RANGES ||
    (source.tokens?.length ?? 0) > MAX_METADATA_RANGES
  ) {
    return "invalid-source";
  }
  // Mixed-script input, literal language, and correction evidence require a richer
  // semantic owner. Leave the complete source available to that owner unchanged.
  if (
    /[^\x20-\x7E\t\n\r]/.test(source.text) ||
    correctionEvidence.test(source.text) ||
    literalEvidence.test(source.text)
  ) {
    return "ambiguous-context";
  }
  return undefined;
}

function removalReason(
  source: DictationCleanupSource,
  removal: CleanupRemoval,
): CleanupReason | undefined {
  const hesitation = source.text.match(hesitationPrefix)?.[0];
  const start = removal.start;
  const rest = source.text.slice(start);
  if (removal.category === "hesitation") {
    if (
      start !== 0 ||
      !hesitation ||
      removal.end !== hesitation.length ||
      !continuation.test(source.text.slice(removal.end))
    ) {
      return "unsafe-removal";
    }
  } else {
    const restart = rest.match(restartPrefix)?.[0];
    if (
      (start !== 0 && start !== hesitation?.length) ||
      !restart ||
      removal.end !== start + restart.length ||
      restartPrefix.test(source.text.slice(removal.end)) ||
      !continuation.test(source.text.slice(removal.end))
    ) {
      return "unsafe-removal";
    }
  }
  if (source.protectedSpans?.some((range) => overlaps(range, removal))) {
    return "protected-text";
  }
  // Uncertain continuation evidence cannot justify deleting a correctly recognized
  // neighboring token. Confidence can veto a deletion, never authorize one.
  const evidenceLength = source.text.slice(removal.end).match(continuation)?.[0].length ?? 0;
  const evidenceRange = { start, end: removal.end + evidenceLength };
  const tokens = source.tokens?.filter((token) => overlaps(token, evidenceRange)) ?? [];
  if (tokens.some((token) => token.confidence !== undefined && token.confidence < 0.85)) {
    return "low-confidence";
  }
  const hasMetadata = tokens.some(
    (token) => token.confidence !== undefined || token.startTimeMs !== undefined,
  );
  if (removal.evidence === "text-and-provider-metadata" && !hasMetadata) {
    return "invalid-plan";
  }
  return undefined;
}

/** Validate proposed deletions against source text, never a model's preferred candidate. */
export function validateCleanupPlan(
  source: DictationCleanupSource,
  policy: CleanupPolicy,
  plan: unknown,
): CleanupResult {
  const reason = sourceReason(source, policy);
  if (reason) {
    return retained(source, reason === "off" ? "unchanged" : "retained", reason);
  }
  if (
    !isRecord(plan) ||
    plan.version !== 1 ||
    !Array.isArray(plan.removals) ||
    plan.removals.length > MAX_REMOVALS
  ) {
    return retained(source, "rejected", "invalid-plan");
  }
  if (plan.sourceId !== source.id || plan.revision !== source.revision) {
    return retained(source, "rejected", "stale-plan");
  }
  const boundaries = new Set([0, source.text.length]);
  for (const segment of segmenter.segment(source.text)) {
    boundaries.add(segment.index);
  }
  for (const range of [...(source.protectedSpans ?? []), ...(source.tokens ?? [])]) {
    if (
      !isRange(range, source.text.length) ||
      !boundaries.has(range.start) ||
      !boundaries.has(range.end)
    ) {
      return retained(source, "rejected", "invalid-source");
    }
  }
  for (const token of source.tokens ?? []) {
    if (
      (token.confidence !== undefined &&
        (!Number.isFinite(token.confidence) || token.confidence < 0 || token.confidence > 1)) ||
      ((token.startTimeMs !== undefined || token.endTimeMs !== undefined) &&
        (token.startTimeMs === undefined ||
          token.endTimeMs === undefined ||
          !Number.isFinite(token.startTimeMs) ||
          !Number.isFinite(token.endTimeMs) ||
          token.startTimeMs < 0 ||
          token.endTimeMs < token.startTimeMs))
    ) {
      return retained(source, "rejected", "invalid-source");
    }
  }
  const removals: CleanupRemoval[] = [];
  const proposedRemovals: readonly unknown[] = plan.removals;
  let previousEnd = 0;
  let removedLength = 0;
  for (const value of proposedRemovals) {
    if (
      !isRange(value, source.text.length) ||
      !isRecord(value) ||
      (value.category !== "hesitation" && value.category !== "exact_restart") ||
      (value.evidence !== "text" && value.evidence !== "text-and-provider-metadata") ||
      !boundaries.has(value.start) ||
      !boundaries.has(value.end) ||
      value.start < previousEnd
    ) {
      return retained(source, "rejected", "invalid-plan");
    }
    const removal: CleanupRemoval = {
      start: value.start,
      end: value.end,
      category: value.category,
      evidence: value.evidence,
    };
    const rejection = removalReason(source, removal);
    if (rejection) {
      return retained(source, "rejected", rejection);
    }
    removals.push(removal);
    previousEnd = removal.end;
    removedLength += removal.end - removal.start;
  }
  if (removedLength > source.text.length / 4) {
    return retained(source, "rejected", "invalid-plan");
  }
  const sourceMap: CleanupSourceMap[] = [];
  const chunks: string[] = [];
  let sourceStart = 0;
  let candidateStart = 0;
  for (const removal of [...removals, { start: source.text.length, end: source.text.length }]) {
    if (removal.start > sourceStart) {
      const chunk = source.text.slice(sourceStart, removal.start);
      chunks.push(chunk);
      sourceMap.push({
        sourceStart,
        sourceEnd: removal.start,
        candidateStart,
        candidateEnd: candidateStart + chunk.length,
      });
      candidateStart += chunk.length;
    }
    sourceStart = removal.end;
  }
  return {
    sourceId: source.id,
    revision: source.revision,
    raw: source.text,
    candidate: chunks.join(""),
    removals,
    status: removals.length ? "refined" : "unchanged",
    sourceMap,
  };
}

/** No provider calls, learned rules, persistent text, or publication side effects. */
export function refineDictation(
  source: DictationCleanupSource,
  policy: CleanupPolicy,
): CleanupResult {
  const reason = sourceReason(source, policy);
  if (reason) {
    return retained(source, reason === "off" ? "unchanged" : "retained", reason);
  }
  const removals: CleanupRemoval[] = [];
  const hesitation = source.text.match(hesitationPrefix)?.[0];
  if (hesitation && continuation.test(source.text.slice(hesitation.length))) {
    removals.push({ start: 0, end: hesitation.length, category: "hesitation", evidence: "text" });
  }
  const start = removals[0]?.end ?? 0;
  const restart = source.text.slice(start).match(restartPrefix)?.[0];
  if (
    restart &&
    !restartPrefix.test(source.text.slice(start + restart.length)) &&
    continuation.test(source.text.slice(start + restart.length))
  ) {
    removals.push({
      start,
      end: start + restart.length,
      category: "exact_restart",
      evidence: "text",
    });
  }
  return validateCleanupPlan(source, policy, {
    version: 1,
    sourceId: source.id,
    revision: source.revision,
    removals,
  });
}
