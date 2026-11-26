/** Private dictation validation. Publication remains with the composer owner. */
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
  | "invalid-plan"
  | "stale-plan"
  | "protected-text"
  | "semantic-unavailable";
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
  return undefined;
}

/** Valid ranges do not establish semantic intent or authorize a text change. */
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
    if (source.protectedSpans?.some((range) => overlaps(range, value))) {
      return retained(source, "rejected", "protected-text");
    }
    if (
      value.evidence === "text-and-provider-metadata" &&
      !source.tokens?.some(
        (token) =>
          overlaps(token, value) &&
          (token.confidence !== undefined || token.startTimeMs !== undefined),
      )
    ) {
      return retained(source, "rejected", "invalid-plan");
    }
    previousEnd = value.end;
    removedLength += value.end - value.start;
  }
  if (removedLength > source.text.length / 4) {
    return retained(source, "rejected", "invalid-plan");
  }
  // No accepted semantic decision owner supplies removal intent. Preserve all
  // recognized text, including intentional repetition and correction evidence.
  return retained(source, "retained", "semantic-unavailable");
}

/** Validate the source without guessing semantic removals or calling a provider. */
export function refineDictation(
  source: DictationCleanupSource,
  policy: CleanupPolicy,
): CleanupResult {
  return validateCleanupPlan(source, policy, {
    version: 1,
    sourceId: source.id,
    revision: source.revision,
    removals: [],
  });
}
