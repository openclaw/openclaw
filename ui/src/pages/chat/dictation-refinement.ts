/** Private, transient edit contract for the current unsent capture. Not an RPC or history. */
export type DictationRange = { start: number; end: number };

export type DictationProtectedSpan = {
  id: string;
  range: DictationRange;
  kind: "literal" | "quote" | "code" | "identifier";
};

export type DictationSourceSegment = {
  range: DictationRange;
  /** Only populate IDs and acoustic times supplied by the recognizer. */
  id?: string;
  eventId?: string;
  sequence?: number;
  captureId?: string;
  speakerId?: string;
  startMs?: number;
  endMs?: number;
};

export type DictationRefinementSource = {
  captureToken: object;
  revision: number;
  text: string;
  locale: string;
  isFinal: boolean;
  segments?: readonly DictationSourceSegment[];
  protectedSpans?: readonly DictationProtectedSpan[];
};

export type DictationRefinementPolicy = { mode: "off" | "explicit"; literal?: boolean };

export type DictationRefinementReason =
  | "off"
  | "literal"
  | "corrections-unavailable"
  | "unsupported-locale"
  | "not-final"
  | "input-too-large"
  | "plan-too-large"
  | "invalid-plan"
  | "source-changed"
  | "invalid-range"
  | "unicode-boundary"
  | "duplicate-id"
  | "overlap"
  | "protected-span"
  | "no-target"
  | "ambiguous-target"
  | "chain-limit"
  | "metadata-incomplete"
  | "metadata-reordered"
  | "cross-speaker"
  | "uncertain-scope"
  | "review-required";

export type DictationEdit = {
  id: string;
  /** A range identity within this source revision, never a fabricated recognizer ID. */
  sourceSpanId: string;
  range: DictationRange;
  replacement: string;
  category: "replacement" | "retraction" | "restart";
  triggerRange: DictationRange;
  chainDepth: number;
};

export type DictationEditPlan = {
  schemaVersion: 1;
  grammarVersion: "en-explicit-v1";
  captureToken: object;
  revision: number;
  sourceText: string;
  ambiguity: "unique";
  edits: readonly DictationEdit[];
  protectedSpans: readonly DictationProtectedSpan[];
};

export type DictationRefinementResult = {
  status: "unchanged" | "needs-review" | "unavailable";
  original: string;
  candidate: string;
  plan: DictationEditPlan | null;
  reasons: readonly DictationRefinementReason[];
};

export const DICTATION_REFINEMENT_LIMITS = {
  characters: 10_000,
  edits: 32,
  chainDepth: 8,
  spans: 256,
} as const;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export function dictationRangesOverlap(a: DictationRange, b: DictationRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function range(value: unknown, length: number): value is DictationRange {
  return (
    record(value) &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    Number.isSafeInteger(value.start) &&
    Number.isSafeInteger(value.end) &&
    value.start >= 0 &&
    value.end > value.start &&
    value.end <= length
  );
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Protect lexical uses even when no developer-syntax processor is installed. */
export function collectDictationProtectedSpans(
  source: DictationRefinementSource,
): DictationProtectedSpan[] {
  const spans = [...(source.protectedSpans ?? [])];
  const add = (start: number, end: number, kind: DictationProtectedSpan["kind"]) => {
    spans.push({ id: `lexical:${kind}:${start}:${end}`, range: { start, end }, kind });
  };
  const text = source.text;
  for (let index = 0; index < text.length; index += 1) {
    const mark = text[index];
    if (mark !== '"' && mark !== "'" && mark !== "`" && mark !== "“" && mark !== "‘") {
      continue;
    }
    const close = mark === "“" ? "”" : mark === "‘" ? "’" : mark;
    // Apostrophes in contractions and possessives are lexical punctuation.
    if (mark === "'" && /[\p{L}\p{N}]/u.test(text[index - 1] ?? "")) {
      continue;
    }
    const delimiter = mark === "`" ? /^`+/.exec(text.slice(index))![0] : close;
    let end = text.indexOf(delimiter, index + delimiter.length);
    while (end >= 0) {
      const escaped = text[end - 1] === "\\";
      const apostrophe =
        (delimiter === "'" || delimiter === "’") &&
        /[\p{L}\p{N}]/u.test(text[end - 1] ?? "") &&
        /[\p{L}\p{N}]/u.test(text[end + 1] ?? "");
      const mismatchedRun =
        mark === "`" && (text[end - 1] === "`" || text[end + delimiter.length] === "`");
      if (!escaped && !apostrophe && !mismatchedRun) {
        break;
      }
      end = text.indexOf(delimiter, end + delimiter.length);
    }
    end = end < 0 ? text.length : end + delimiter.length;
    add(index, end, mark === "`" ? "code" : "quote");
    index = end - 1;
  }
  for (const match of text.matchAll(/\b(?:begin\s+quote|quote)\b/giu)) {
    const start = match.index;
    if (spans.some((span) => span.range.start <= start && start < span.range.end)) {
      continue;
    }
    const tail = text.slice(start + match[0].length);
    const ending = /\bend\s+quote\b/iu.exec(tail);
    add(
      start,
      ending ? start + match[0].length + ending.index + ending[0].length : text.length,
      "quote",
    );
  }
  for (const match of text.matchAll(
    /(?:https?:\/\/|www\.)\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+|(?:\/[\w.-]+){2,}|\b[\p{L}\p{N}]+_[\p{L}\p{N}_]+\b/giu,
  )) {
    add(match.index, match.index + match[0].length, "identifier");
  }
  return spans;
}

export function inspectDictationSource(
  source: DictationRefinementSource,
): DictationRefinementReason | null {
  if (source.text.length > DICTATION_REFINEMENT_LIMITS.characters) {
    return "input-too-large";
  }
  if (!source.captureToken || !Number.isSafeInteger(source.revision) || source.revision < 0) {
    return "invalid-plan";
  }
  if (!isWellFormed(source.text)) {
    return "unicode-boundary";
  }
  const segments = source.segments ?? [];
  if (segments.length > DICTATION_REFINEMENT_LIMITS.spans) {
    return "plan-too-large";
  }
  const ids = new Set<string>();
  const speakers = new Set<string>();
  const captures = new Set<string>();
  let previousSequence = -1;
  let previousEnd = 0;
  let previousAcousticEnd = 0;
  let incomplete = segments.length === 0;
  for (const segment of segments) {
    if (!range(segment.range, source.text.length)) {
      return "invalid-range";
    }
    if (segment.range.start < previousEnd) {
      return "metadata-reordered";
    }
    previousEnd = segment.range.end;
    for (const [kind, id] of [
      ["segment", segment.id],
      ["event", segment.eventId],
    ] as const) {
      if (id === undefined) {
        continue;
      }
      const key = `${kind}:${id}`;
      if (!identifier(id) || ids.has(key)) {
        return "duplicate-id";
      }
      ids.add(key);
    }
    if (segment.sequence === undefined) {
      incomplete = true;
    } else if (!Number.isSafeInteger(segment.sequence) || segment.sequence <= previousSequence) {
      return "metadata-reordered";
    } else {
      previousSequence = segment.sequence;
    }
    if (segment.speakerId) {
      speakers.add(segment.speakerId);
    }
    if (segment.captureId) {
      captures.add(segment.captureId);
    }
    if (segment.startMs === undefined || segment.endMs === undefined) {
      incomplete = true;
    } else if (
      !Number.isFinite(segment.startMs) ||
      !Number.isFinite(segment.endMs) ||
      segment.startMs < previousAcousticEnd ||
      segment.endMs < segment.startMs
    ) {
      return "metadata-reordered";
    } else {
      previousAcousticEnd = segment.endMs;
    }
  }
  if (captures.size > 1) {
    return "source-changed";
  }
  if (speakers.size > 1) {
    return "cross-speaker";
  }
  return incomplete ? "metadata-incomplete" : null;
}

export type DictationPlanValidation =
  | { ok: true; candidate: string }
  | { ok: false; reason: DictationRefinementReason };

/** Validate once at the plan boundary. Publication still belongs to the capture owner. */
export function validateDictationPlan(
  source: DictationRefinementSource,
  plan: unknown,
): DictationPlanValidation {
  const fail = (reason: DictationRefinementReason): DictationPlanValidation => ({
    ok: false,
    reason,
  });
  if (!source.isFinal) {
    return fail("not-final");
  }
  const sourceReason = inspectDictationSource(source);
  if (sourceReason && sourceReason !== "metadata-incomplete") {
    return fail(sourceReason);
  }
  if (
    !record(plan) ||
    plan.schemaVersion !== 1 ||
    plan.grammarVersion !== "en-explicit-v1" ||
    plan.ambiguity !== "unique" ||
    !Array.isArray(plan.edits) ||
    !Array.isArray(plan.protectedSpans)
  ) {
    return fail("invalid-plan");
  }
  if (
    plan.captureToken !== source.captureToken ||
    plan.revision !== source.revision ||
    plan.sourceText !== source.text
  ) {
    return fail("source-changed");
  }
  if (
    plan.edits.length > DICTATION_REFINEMENT_LIMITS.edits ||
    plan.protectedSpans.length > DICTATION_REFINEMENT_LIMITS.spans ||
    (source.protectedSpans?.length ?? 0) > DICTATION_REFINEMENT_LIMITS.spans
  ) {
    return fail("plan-too-large");
  }
  const protection = collectDictationProtectedSpans(source);
  if (protection.length > DICTATION_REFINEMENT_LIMITS.spans) {
    return fail("plan-too-large");
  }
  if (plan.protectedSpans.length !== protection.length) {
    return fail("invalid-plan");
  }
  const declaredProtection: unknown[] = plan.protectedSpans;
  const declaredIds = new Set<string>();
  for (const [index, span] of declaredProtection.entries()) {
    const expected = protection[index]!;
    if (!record(span) || !identifier(span.id) || !range(span.range, source.text.length)) {
      return fail("invalid-plan");
    }
    if (declaredIds.has(span.id)) {
      return fail("duplicate-id");
    }
    declaredIds.add(span.id);
    if (
      span.id !== expected.id ||
      span.kind !== expected.kind ||
      span.range.start !== expected.range.start ||
      span.range.end !== expected.range.end
    ) {
      return fail("invalid-plan");
    }
  }
  const boundaries = new Set([0, source.text.length]);
  for (const segment of graphemes.segment(source.text)) {
    boundaries.add(segment.index);
  }
  const validBoundary = (span: DictationRange) =>
    boundaries.has(span.start) && boundaries.has(span.end);
  const protectedIds = new Set<string>();
  for (const span of protection) {
    if (!identifier(span.id) || protectedIds.has(span.id)) {
      return fail("duplicate-id");
    }
    protectedIds.add(span.id);
    if (!range(span.range, source.text.length)) {
      return fail("invalid-range");
    }
    if (!validBoundary(span.range)) {
      return fail("unicode-boundary");
    }
  }
  const edits: DictationEdit[] = [];
  const ids = new Set<string>();
  const sourceIds = new Set<string>();
  const rawEdits: unknown[] = plan.edits;
  for (const edit of rawEdits) {
    if (
      !record(edit) ||
      !identifier(edit.id) ||
      !identifier(edit.sourceSpanId) ||
      typeof edit.replacement !== "string" ||
      (edit.category !== "replacement" &&
        edit.category !== "retraction" &&
        edit.category !== "restart")
    ) {
      return fail("invalid-plan");
    }
    if (ids.has(edit.id) || sourceIds.has(edit.sourceSpanId)) {
      return fail("duplicate-id");
    }
    ids.add(edit.id);
    sourceIds.add(edit.sourceSpanId);
    const { range: editRange, triggerRange } = edit;
    if (!range(editRange, source.text.length) || !range(triggerRange, source.text.length)) {
      return fail("invalid-range");
    }
    if (
      !validBoundary(editRange) ||
      !validBoundary(triggerRange) ||
      !isWellFormed(edit.replacement)
    ) {
      return fail("unicode-boundary");
    }
    if (
      typeof edit.chainDepth !== "number" ||
      !Number.isSafeInteger(edit.chainDepth) ||
      edit.chainDepth < 1 ||
      edit.chainDepth > DICTATION_REFINEMENT_LIMITS.chainDepth
    ) {
      return fail("chain-limit");
    }
    if (edit.replacement.length > DICTATION_REFINEMENT_LIMITS.characters) {
      return fail("plan-too-large");
    }
    if (
      protection.some(
        (span) =>
          dictationRangesOverlap(span.range, editRange) ||
          dictationRangesOverlap(span.range, triggerRange),
      )
    ) {
      return fail("protected-span");
    }
    edits.push({
      id: edit.id,
      sourceSpanId: edit.sourceSpanId,
      range: editRange,
      replacement: edit.replacement,
      category: edit.category,
      triggerRange,
      chainDepth: edit.chainDepth,
    });
  }
  edits.sort((a, b) => a.range.start - b.range.start);
  let cursor = 0;
  let candidate = "";
  for (const edit of edits) {
    if (edit.range.start < cursor) {
      return fail("overlap");
    }
    candidate += source.text.slice(cursor, edit.range.start) + edit.replacement;
    cursor = edit.range.end;
  }
  candidate += source.text.slice(cursor);
  return candidate.length <= DICTATION_REFINEMENT_LIMITS.characters
    ? { ok: true, candidate }
    : fail("plan-too-large");
}
