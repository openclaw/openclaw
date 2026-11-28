/** Proposed shared M11 boundary. All source/output ranges are half-open UTF-16. */
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

export type DictationProtectedRange = { start: number; end: number };

export type DictationEditPlan = {
  schemaVersion: 1;
  offsetEncoding: "utf-16";
  captureId: string;
  generation: number;
  transcriptRevision: number;
  profileId: string;
  profileRevision: number;
  supported: boolean;
  edits: readonly DictationLiteralCandidate[];
  protectedSpans: readonly DictationProtectedRange[];
  diagnostics: readonly { severity: "blocking" | "warning" }[];
};

export type DictationRefinementResult = {
  captureId: string;
  generation: number;
  transcriptRevision: number;
  text: string;
  protectedSpans: Array<DictationLiteralCandidate & { outputStart: number; outputEnd: number }>;
  profileId?: string;
  profileRevision?: number;
  /** Present only for explicitly admitted download-only review output. */
  unsafeOutputBoundary?: true;
};

const MAX_TRANSCRIPT_BYTES = 128 * 1024;
const MAX_CANDIDATES = 64;
const MAX_PROTECTED_RANGES = 256;
const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function boundaries(text: string): Set<number> {
  if (text.length > MAX_TRANSCRIPT_BYTES || byteLength(text) > MAX_TRANSCRIPT_BYTES) {
    throw new Error("dictation-size-limit");
  }
  // TextEncoder replaces isolated surrogates, so byte equality requires rejecting them.
  for (const scalar of text) {
    const code = scalar.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new Error("dictation-invalid-unicode");
    }
  }
  const result = new Set([0, text.length]);
  for (const segment of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)) {
    result.add(segment.index);
  }
  return result;
}

function validateRequest(request: DictationRefinementRequest): void {
  if (
    request.schemaVersion !== 1 ||
    request.mode !== "dictation" ||
    typeof request.captureId !== "string" ||
    !request.captureId ||
    request.captureId.length > 128 ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Number.isSafeInteger(request.transcriptRevision) ||
    request.transcriptRevision < 0 ||
    typeof request.rawTranscript !== "string"
  ) {
    throw new Error("dictation-invalid-request");
  }
}

function prepareComposition(
  request: DictationRefinementRequest,
  candidates: readonly DictationLiteralCandidate[],
  protectedRanges: readonly DictationProtectedRange[],
) {
  validateRequest(request);
  if (candidates.length > MAX_CANDIDATES || protectedRanges.length > MAX_PROTECTED_RANGES) {
    throw new Error("dictation-edit-limit");
  }
  const raw = request.rawTranscript;
  const validBoundaries = boundaries(raw);
  const ordered = [
    ...candidates,
    ...protectedRanges.map((range, index) => ({
      intentId: `protected:${index}`,
      ...range,
      source: raw.slice(range.start, range.end),
      text: raw.slice(range.start, range.end),
    })),
  ].toSorted((a, b) => a.start - b.start);
  const ids = new Set<string>();
  const prose: string[] = [];
  let end = 0;
  let literalBytes = 0;
  for (const candidate of ordered) {
    if (
      !Number.isSafeInteger(candidate.start) ||
      !Number.isSafeInteger(candidate.end) ||
      candidate.start < end ||
      candidate.end <= candidate.start ||
      candidate.end > raw.length ||
      !validBoundaries.has(candidate.start) ||
      !validBoundaries.has(candidate.end) ||
      typeof candidate.intentId !== "string" ||
      !candidate.intentId ||
      candidate.intentId.length > 128 ||
      ids.has(candidate.intentId) ||
      raw.slice(candidate.start, candidate.end) !== candidate.source ||
      typeof candidate.text !== "string" ||
      candidate.text.length > MAX_TRANSCRIPT_BYTES ||
      (candidate.text !== candidate.source && byteLength(candidate.text) > 16 * 1024)
    ) {
      throw new Error("dictation-invalid-edit");
    }
    boundaries(candidate.text);
    // Already present opaque source bytes are bounded by the transcript limit.
    // The smaller replacement budget constrains expansion, not a Literal capture.
    literalBytes += candidate.text === candidate.source ? 0 : byteLength(candidate.text);
    if (literalBytes > 64 * 1024) {
      throw new Error("dictation-literal-limit");
    }
    ids.add(candidate.intentId);
    prose.push(raw.slice(end, candidate.start));
    end = candidate.end;
  }
  prose.push(raw.slice(end));
  return { ordered, prose };
}

function compose(
  request: DictationRefinementRequest,
  ordered: readonly DictationLiteralCandidate[],
  prose: readonly string[],
  outputBoundaryPolicy: "strict" | "download-only-review" = "strict",
): DictationRefinementResult {
  if (prose.length !== ordered.length + 1 || prose.some((text) => typeof text !== "string")) {
    throw new Error("dictation-invalid-transform");
  }
  const totalLength = [...prose, ...ordered.map((candidate) => candidate.text)].reduce(
    (sum, part) => sum + part.length,
    0,
  );
  if (totalLength > MAX_TRANSCRIPT_BYTES) {
    throw new Error("dictation-size-limit");
  }
  let text = prose[0]!;
  const protectedSpans: DictationRefinementResult["protectedSpans"] = [];
  for (const [index, candidate] of ordered.entries()) {
    const outputStart = text.length;
    text += candidate.text;
    protectedSpans.push({ ...candidate, outputStart, outputEnd: text.length });
    text += prose[index + 1]!;
    if (text.length > MAX_TRANSCRIPT_BYTES) {
      throw new Error("dictation-size-limit");
    }
  }
  const outputBoundaries = boundaries(text);
  const unsafeOutputBoundary = protectedSpans.some(
    (span) => !outputBoundaries.has(span.outputStart) || !outputBoundaries.has(span.outputEnd),
  );
  if (unsafeOutputBoundary && outputBoundaryPolicy === "strict") {
    throw new Error("dictation-output-boundary");
  }
  return {
    captureId: request.captureId,
    generation: request.generation,
    transcriptRevision: request.transcriptRevision,
    text,
    protectedSpans,
    ...(unsafeOutputBoundary ? { unsafeOutputBoundary: true } : {}),
  };
}

/** Only untouched prose reaches an enabled punctuation/style/filler stage. */
export async function refineDictation(
  request: DictationRefinementRequest,
  candidates: readonly DictationLiteralCandidate[],
  options: {
    signal: AbortSignal;
    protectedRanges?: readonly DictationProtectedRange[];
    outputBoundaryPolicy?: "download-only-review";
    transformProse?: (prose: readonly string[], signal: AbortSignal) => Promise<readonly string[]>;
  },
): Promise<DictationRefinementResult> {
  options.signal.throwIfAborted();
  const { ordered, prose } = prepareComposition(request, candidates, options.protectedRanges ?? []);
  // Own the admitted values across the optional asynchronous stage.
  const admitted = { ...request };
  const literals: DictationLiteralCandidate[] = [];
  for (const candidate of ordered) {
    literals.push({ ...candidate });
  }
  const transformed = options.transformProse
    ? await options.transformProse(prose, options.signal)
    : prose;
  options.signal.throwIfAborted();
  return compose(admitted, literals, transformed, options.outputBoundaryPolicy);
}

/** Deterministic plans publish only after identity, ambiguity and range validation. */
export function applyDictationPlan(
  request: DictationRefinementRequest,
  plan: DictationEditPlan,
): DictationRefinementResult {
  if (
    plan.schemaVersion !== 1 ||
    plan.offsetEncoding !== "utf-16" ||
    plan.captureId !== request.captureId ||
    plan.generation !== request.generation ||
    plan.transcriptRevision !== request.transcriptRevision ||
    !plan.supported ||
    typeof plan.profileId !== "string" ||
    !plan.profileId ||
    plan.profileId.length > 128 ||
    !Number.isSafeInteger(plan.profileRevision) ||
    plan.profileRevision < 1 ||
    plan.diagnostics.length > 64 ||
    plan.diagnostics.some((diagnostic) => diagnostic.severity !== "warning")
  ) {
    throw new Error("dictation-unreviewable-plan");
  }
  const { ordered, prose } = prepareComposition(request, plan.edits, plan.protectedSpans);
  return {
    ...compose(request, ordered, prose),
    profileId: plan.profileId,
    profileRevision: plan.profileRevision,
  };
}

/** Editor adapters must explicitly translate offsets and retain grapheme boundaries. */
export function convertDictationOffset(
  text: string,
  offset: number,
  from: "utf-16" | "utf-8" | "code-point",
  to: "utf-16" | "utf-8" | "code-point",
): number {
  const validBoundaries = boundaries(text);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("dictation-invalid-offset");
  }
  let utf16 = 0;
  let utf8 = 0;
  let codePoint = 0;
  const value = (encoding: typeof from) =>
    encoding === "utf-16" ? utf16 : encoding === "utf-8" ? utf8 : codePoint;
  for (const scalar of text) {
    if (value(from) >= offset) {
      break;
    }
    utf16 += scalar.length;
    utf8 += byteLength(scalar);
    codePoint += 1;
  }
  if (value(from) !== offset || !validBoundaries.has(utf16)) {
    throw new Error("dictation-invalid-offset");
  }
  return value(to);
}
