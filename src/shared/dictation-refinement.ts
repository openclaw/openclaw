/** Neutral M11 boundary: source offsets are half-open UTF-16 ranges. */
export type DictationRefinementRequest = {
  schemaVersion: 1;
  captureId: string;
  generation: number;
  transcriptRevision: number;
  mode: "dictation" | "agent";
  rawTranscript: string;
};

export type DictationLiteralCandidate = {
  intentId: string;
  start: number;
  end: number;
  source: string;
  text: string;
  catalogRevision?: number;
  snippetId?: string;
  snippetRevision?: number;
};

export type DictationRefinementResult = {
  captureId: string;
  generation: number;
  transcriptRevision: number;
  text: string;
  protectedSpans: Array<DictationLiteralCandidate & { outputStart: number; outputEnd: number }>;
};

const MAX_TRANSCRIPT_BYTES = 128 * 1024;
const MAX_CANDIDATES = 64;

/** Only unprotected prose reaches a transform, in one bounded batch. */
export async function refineDictation(
  request: DictationRefinementRequest,
  candidates: readonly DictationLiteralCandidate[],
  options: {
    signal: AbortSignal;
    transformProse?: (prose: readonly string[], signal: AbortSignal) => Promise<readonly string[]>;
  },
): Promise<DictationRefinementResult> {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  const abort = () => {
    if (options.signal.aborted) {
      throw new Error("cancelled");
    }
  };
  abort();
  if (
    request.schemaVersion !== 1 ||
    !request.captureId ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Number.isSafeInteger(request.transcriptRevision) ||
    request.transcriptRevision < 0 ||
    request.mode !== "dictation" ||
    bytes(request.rawTranscript) > MAX_TRANSCRIPT_BYTES ||
    candidates.length > MAX_CANDIDATES
  ) {
    throw new Error("limit");
  }
  const boundaries = new Set([0, request.rawTranscript.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    request.rawTranscript,
  )) {
    boundaries.add(segment.index);
  }
  const ordered = candidates.toSorted((a, b) => a.start - b.start);
  const prose: string[] = [];
  const ids = new Set<string>();
  let end = 0;
  let literalBytes = 0;
  for (const candidate of ordered) {
    literalBytes += bytes(candidate.text);
    if (
      !Number.isSafeInteger(candidate.start) ||
      !Number.isSafeInteger(candidate.end) ||
      candidate.start < end ||
      candidate.end <= candidate.start ||
      candidate.end > request.rawTranscript.length ||
      !boundaries.has(candidate.start) ||
      !boundaries.has(candidate.end) ||
      ids.has(candidate.intentId) ||
      request.rawTranscript.slice(candidate.start, candidate.end) !== candidate.source ||
      bytes(candidate.text) > 16 * 1024 ||
      literalBytes > 64 * 1024
    ) {
      throw new Error("limit");
    }
    ids.add(candidate.intentId);
    prose.push(request.rawTranscript.slice(end, candidate.start));
    end = candidate.end;
  }
  prose.push(request.rawTranscript.slice(end));
  const transformed = options.transformProse
    ? await options.transformProse(prose, options.signal)
    : prose;
  abort();
  if (
    transformed.length !== prose.length ||
    transformed.some((text) => typeof text !== "string") ||
    transformed.reduce((sum, text) => sum + bytes(text), 0) > MAX_TRANSCRIPT_BYTES
  ) {
    throw new Error("invalid-transform");
  }
  let text = transformed[0]!;
  const protectedSpans: DictationRefinementResult["protectedSpans"] = [];
  for (const [index, candidate] of ordered.entries()) {
    const outputStart = text.length;
    // Stored bytes are concatenated directly, never offered to a semantic transform.
    text += candidate.text;
    protectedSpans.push({ ...candidate, outputStart, outputEnd: text.length });
    text += transformed[index + 1]!;
  }
  return {
    captureId: request.captureId,
    generation: request.generation,
    transcriptRevision: request.transcriptRevision,
    text,
    protectedSpans,
  };
}
