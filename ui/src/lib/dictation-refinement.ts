/** Local-only punctuation. Offsets are half-open UTF-16 ranges in the raw revision. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type DictationPunctuationMode = "verbatim" | "automatic" | "explicit";

export type DictationPunctuationPolicy = Readonly<{
  mode: DictationPunctuationMode;
  locale?: string;
  explicitEnabled: boolean;
  fragment?: boolean;
}>;

type DictationProtectedSpan = Readonly<{ start: number; end: number }>;

export type DictationRefinementRequest = Readonly<{
  schemaVersion: 1;
  captureId: string;
  generation: number;
  transcriptRevision: number;
  rawTranscript: string;
  isFinal: boolean;
  policy: DictationPunctuationPolicy;
  /** Only a caller-authorized, bounded snapshot; absence is not an empty field. */
  context?: Readonly<{ left: string; right: string }>;
  mixedLocale?: boolean;
}>;

export type DictationSourceEdit = Readonly<{
  start: number;
  end: number;
  text: string;
  reason: "punctuation-insert" | "punctuation-remove" | "sentence-case" | "explicit-punctuation";
}>;

export type DictationRefinementReason =
  | "verbatim"
  | "unchanged"
  | "unsupported-locale"
  | "mixed-locale"
  | "context-unavailable"
  | "explicit-disabled"
  | "ambiguous-command"
  | "unsupported-version"
  | "invalid-request"
  | "incomplete-transcript"
  | "input-too-large"
  | "invalid-candidate"
  | "revision-mismatch"
  | "invalid-edit-map"
  | "protected-text"
  | "lexical-change"
  | "unapproved-edit"
  | "output-too-large";

export type DictationRefinementResult = Readonly<{
  schemaVersion: 1;
  captureId: string;
  generation: number;
  transcriptRevision: number;
  text: string;
  status: "refined" | "raw-fallback" | "needs-review" | "unavailable";
  edits: readonly DictationSourceEdit[];
  reasons: readonly DictationRefinementReason[];
  effectiveLocale: string | null;
  policyVersion: 1;
}>;

type Candidate = {
  schemaVersion: 1;
  policyVersion: 1;
  captureId: string;
  generation: number;
  transcriptRevision: number;
  text: string;
  edits: DictationSourceEdit[];
};

const MAX_TRANSCRIPT_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 8 * 1024;
const MAX_EDITS = 128;
const encoder = new TextEncoder();
let graphemes: Intl.Segmenter | undefined;
let words: Intl.Segmenter | undefined;

function graphemeBoundaries(text: string): Set<number> {
  // The same ICU grapheme machinery as normalization-core and the Control UI.
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const boundaries = new Set<number>([text.length]);
  for (const { index } of graphemes.segment(text)) {
    boundaries.add(index);
  }
  return boundaries;
}

function effectiveLocale(request: DictationRefinementRequest): string | null {
  const locale = request.policy?.locale;
  if (typeof locale !== "string" || locale.length > 64) {
    return null;
  }
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    return null;
  }
}

function rawResult(
  request: DictationRefinementRequest,
  reason: DictationRefinementReason,
  status: DictationRefinementResult["status"] = "raw-fallback",
): DictationRefinementResult {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    captureId: request.captureId,
    generation: request.generation,
    transcriptRevision: request.transcriptRevision,
    text: request.rawTranscript,
    status,
    edits: [],
    reasons: [reason],
    effectiveLocale: effectiveLocale(request),
  };
}

function withinBytes(text: string, limit: number): boolean {
  return text.length <= limit && encoder.encode(text).byteLength <= limit;
}

function requestProblem(
  request: DictationRefinementRequest,
): DictationRefinementReason | undefined {
  if (request.schemaVersion !== 1) {
    return "unsupported-version";
  }
  if (
    typeof request.captureId !== "string" ||
    !request.captureId ||
    request.captureId.length > 128 ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Number.isSafeInteger(request.transcriptRevision) ||
    request.transcriptRevision < 0 ||
    typeof request.rawTranscript !== "string" ||
    typeof request.isFinal !== "boolean" ||
    !isRecord(request.policy) ||
    !["verbatim", "automatic", "explicit"].includes(request.policy.mode) ||
    typeof request.policy.explicitEnabled !== "boolean" ||
    (request.policy.fragment !== undefined && typeof request.policy.fragment !== "boolean") ||
    (request.policy.locale !== undefined && typeof request.policy.locale !== "string") ||
    (request.mixedLocale !== undefined && typeof request.mixedLocale !== "boolean")
  ) {
    return "invalid-request";
  }
  if (!request.isFinal) {
    return "incomplete-transcript";
  }
  if (!withinBytes(request.rawTranscript, MAX_TRANSCRIPT_BYTES)) {
    return "input-too-large";
  }
  if (
    request.context !== undefined &&
    (!isRecord(request.context) ||
      typeof request.context.left !== "string" ||
      typeof request.context.right !== "string")
  ) {
    return "invalid-request";
  }
  if (
    request.context &&
    !withinBytes(request.context.left + request.context.right, MAX_CONTEXT_BYTES)
  ) {
    return "input-too-large";
  }
  // A recognizer can supply malformed UTF-16. Keep it raw, never manufacture a repair.
  for (const point of request.rawTranscript) {
    if (point.length === 1 && /[\uD800-\uDFFF]/u.test(point)) {
      return "invalid-request";
    }
  }
  return undefined;
}

function overlaps(start: number, end: number, span: DictationProtectedSpan): boolean {
  return start === end
    ? start > span.start && start < span.end
    : start < span.end && end > span.start;
}

function touchesProtected(
  spans: readonly DictationProtectedSpan[],
  start: number,
  end: number,
): boolean {
  let left = 0;
  let right = spans.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    // SAFETY: left < right <= spans.length bounds this midpoint to a merged span.
    if (spans[middle]!.end <= start) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }
  const span = spans[left];
  return span !== undefined && overlaps(start, end, span);
}

type Protection = { spans: DictationProtectedSpan[]; openLiteral: boolean };

function protectedRanges(text: string, boundaries: Set<number>): Protection {
  const spans: DictationProtectedSpan[] = [];
  const protect = (start: number, end: number) => {
    let protectedStart = start;
    let protectedEnd = end;
    while (!boundaries.has(protectedStart)) {
      protectedStart -= 1;
    }
    while (!boundaries.has(protectedEnd)) {
      protectedEnd += 1;
    }
    spans.push({ start: protectedStart, end: protectedEnd });
  };
  let openLiteral = false;
  // Protect the entire envelope of each delimiter family, including ambiguous
  // nesting and escaped delimiters. Overprotection is preferable to interpreting
  // a quoted mark name, including a JSON string that retains its escapes.
  // Unclosed literals include newlines and never receive a terminal insertion.
  for (const [opening, closing] of [
    ["`", "`"],
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ]) {
    const openings: number[] = [];
    const closings: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character !== opening && character !== closing) {
        continue;
      }
      if (character === opening) {
        if (
          opening === "'" &&
          !openings.length &&
          /[\p{L}\p{N}\p{M}]/u.test(text[index - 1] ?? "")
        ) {
          continue;
        }
        openings.push(index);
      }
      if (character === closing && openings.length) {
        closings.push(index);
      }
    }
    const start = openings[0];
    if (start === undefined) {
      continue;
    }
    const end = closings.at(-1);
    const unclosed =
      opening === closing
        ? openings.length % 2 !== 0
        : openings.length !== closings.length || end === undefined || openings.at(-1)! > end;
    openLiteral ||= unclosed;
    protect(start, unclosed || end === undefined ? text.length : end + 1);
  }
  for (const match of text.matchAll(/\S+/gu)) {
    const token = match[0];
    if (
      /[\p{N}\p{Lu}\p{Lt}_@/\\#=+$%<>]|\S[.:]\S|^\.|[\p{L}]['’][\p{L}]|[\p{L}]-[\p{L}]/u.test(token)
    ) {
      // Numbers/dates, versions, URLs, email, paths, IDs, and intentional casing
      // remain byte-exact. This deliberately overprotects ambiguous technical text.
      protect(match.index, match.index + token.length);
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return { spans: merged, openLiteral };
}

const marks: Readonly<Record<string, string>> = {
  comma: ",",
  period: ".",
  "full stop": ".",
  "question mark": "?",
  "exclamation mark": "!",
  colon: ":",
  semicolon: ";",
};

function explicitEdits(
  source: string,
  spans: readonly DictationProtectedSpan[],
): DictationSourceEdit[] | undefined {
  const commands = [
    ...source.matchAll(
      /(?<![\p{L}\p{N}\p{M}_])(?:(insert)[ \t]+)?(question mark|exclamation mark|full stop|comma|period|semicolon|colon)(?![\p{L}\p{N}\p{M}_])/giu,
    ),
  ].filter((match) => !touchesProtected(spans, match.index, match.index + match[0].length));
  if (!commands.length) {
    return [];
  }
  // Mark commands require an explicit "insert" introducer. The only bare-name
  // shorthand is a conventional single-word greeting, "hello comma world period".
  // This is a declared grammar, not an inference about natural-language intent.
  const introduced = commands.every((match) => match[1] !== undefined);
  const greeting =
    commands.length === 2 &&
    commands.every((match) => match[1] === undefined) &&
    /^[ \t]*hello[ \t]+comma,?[ \t]+[\p{L}][\p{L}\p{M}'’-]*[ \t]+period\.?[ \t]*$/iu.test(source);
  const lastName = commands.at(-1)?.[2];
  const lastMark = lastName ? marks[lastName.toLowerCase()] : undefined;
  if (
    (!introduced && !greeting) ||
    commands.length > MAX_EDITS ||
    !lastMark ||
    !/[.!?]/u.test(lastMark)
  ) {
    return undefined;
  }
  const edits: DictationSourceEdit[] = [];
  for (const [index, match] of commands.entries()) {
    const name = match[2];
    const mark = name ? marks[name.toLowerCase()] : undefined;
    const next = commands[index + 1];
    const before = source.slice(0, match.index);
    const after = source.slice(match.index + match[0].length);
    const separator = /[ \t]+$/u.exec(before);
    const terminal = mark === "." || mark === "?" || mark === "!";
    if (
      !mark ||
      !separator ||
      !/\S/u.test(before) ||
      (terminal ? !/^[.!?]?[ \t]*$/u.test(after) : !/^[,;:]?[ \t]+[\p{L}\p{N}]/u.test(after)) ||
      (next && /^\s*$/u.test(source.slice(match.index + match[0].length, next.index)))
    ) {
      return undefined;
    }
    // ASR may already render the requested mark after the spoken name. Consume
    // only its words and preceding separator, leaving that existing mark once.
    const existing = /^[,;:.!?]/u.exec(after)?.[0];
    if (existing && existing !== mark) {
      return undefined;
    }
    edits.push({
      start: match.index - separator[0].length,
      end: match.index + match[0].length,
      text: existing ? "" : mark,
      reason: "explicit-punctuation",
    });
  }
  return edits;
}

type Plan = {
  boundaries: Set<number>;
  spans: DictationProtectedSpan[];
  edits: DictationSourceEdit[];
};

function prepare(request: DictationRefinementRequest): Plan | DictationRefinementReason {
  const invalid = requestProblem(request);
  if (invalid) {
    return invalid;
  }
  const boundaries = graphemeBoundaries(request.rawTranscript);
  if (request.policy.mode === "verbatim") {
    return "verbatim";
  }
  if (effectiveLocale(request) !== "en-US") {
    return "unsupported-locale";
  }
  if (request.mixedLocale || /[^\p{Script=Latin}\p{M}\P{L}]/u.test(request.rawTranscript)) {
    return "mixed-locale";
  }
  if (!request.context) {
    return "context-unavailable";
  }
  if (request.policy.mode === "explicit" && !request.policy.explicitEnabled) {
    return "explicit-disabled";
  }
  const raw = request.rawTranscript;
  const { spans, openLiteral } = protectedRanges(raw, boundaries);
  const edits = request.policy.mode === "explicit" ? explicitEdits(raw, spans) : [];
  if (!edits) {
    return "ambiguous-command";
  }
  if (!request.policy.fragment) {
    const first = /^\s*([a-z])/u.exec(raw);
    if (first && !request.context.left.trim()) {
      const start = first[0].length - 1;
      let end = start + 1;
      while (!boundaries.has(end)) {
        end += 1;
      }
      if (!touchesProtected(spans, start, end)) {
        edits.push({
          start,
          end,
          text: raw.slice(start, end).replace(/^[a-z]/u, (letter) => letter.toUpperCase()),
          reason: "sentence-case",
        });
      }
    }
    const end = raw.trimEnd().length;
    const terminalCommand = edits.some(
      (edit) =>
        edit.reason === "explicit-punctuation" && edit.end === end && /[.!?]/u.test(edit.text),
    );
    const hasProse = [...raw.matchAll(/[\p{L}\p{M}]+/gu)].some(
      (match) => !touchesProtected(spans, match.index, match.index + match[0].length),
    );
    if (
      end > 0 &&
      hasProse &&
      !openLiteral &&
      !terminalCommand &&
      !request.context.right.trim() &&
      !/[.!?…,:;]["”’')\]}]*$/u.test(raw.slice(0, end)) &&
      /[\p{L}\p{N}\p{M}"”’')\]}]$/u.test(raw.slice(0, end))
    ) {
      edits.push({ start: end, end, text: ".", reason: "punctuation-insert" });
    }
  }
  edits.sort((a, b) => a.start - b.start);
  return { boundaries, spans, edits };
}

function applyEdits(raw: string, edits: readonly DictationSourceEdit[]): string {
  let text = "";
  let cursor = 0;
  for (const edit of edits) {
    text += raw.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return text + raw.slice(cursor);
}

function lexicalTokens(text: string): string[] {
  words ??= new Intl.Segmenter("en-US", { granularity: "word" });
  return [...words.segment(text)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.toLocaleLowerCase("en-US"));
}

function validate(
  request: DictationRefinementRequest,
  candidate: unknown,
  plan: Plan,
): DictationRefinementResult {
  if (
    !isRecord(candidate) ||
    typeof candidate.text !== "string" ||
    !Array.isArray(candidate.edits)
  ) {
    return rawResult(request, "invalid-candidate", "needs-review");
  }
  if (candidate.schemaVersion !== 1 || candidate.policyVersion !== 1) {
    return rawResult(request, "unsupported-version", "needs-review");
  }
  if (
    candidate.captureId !== request.captureId ||
    candidate.generation !== request.generation ||
    candidate.transcriptRevision !== request.transcriptRevision
  ) {
    return rawResult(request, "revision-mismatch", "needs-review");
  }
  if (!withinBytes(candidate.text, MAX_TRANSCRIPT_BYTES + MAX_EDITS)) {
    return rawResult(request, "output-too-large", "needs-review");
  }
  if (candidate.edits.length > MAX_EDITS) {
    return rawResult(request, "invalid-edit-map", "needs-review");
  }
  const edits: DictationSourceEdit[] = [];
  let previousEnd = 0;
  let previousStart = -1;
  for (const edit of candidate.edits) {
    if (
      !isRecord(edit) ||
      typeof edit.start !== "number" ||
      typeof edit.end !== "number" ||
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      !plan.boundaries.has(edit.start) ||
      !plan.boundaries.has(edit.end) ||
      edit.start < previousEnd ||
      edit.start <= previousStart ||
      edit.end < edit.start ||
      typeof edit.text !== "string" ||
      edit.text.length > 32
    ) {
      return rawResult(request, "invalid-edit-map", "needs-review");
    }
    if (touchesProtected(plan.spans, edit.start, edit.end)) {
      return rawResult(request, "protected-text", "needs-review");
    }
    // A lexical comparison alone permits apostrophe removal or a period before
    // negation. Only the declared locale pack's exact permitted edits can pass.
    const permitted = plan.edits.find(
      (allowed) =>
        allowed.start === edit.start &&
        allowed.end === edit.end &&
        allowed.text === edit.text &&
        allowed.reason === edit.reason,
    );
    if (!permitted) {
      return rawResult(request, "unapproved-edit", "needs-review");
    }
    edits.push(permitted);
    previousStart = edit.start;
    previousEnd = edit.end;
  }
  if (applyEdits(request.rawTranscript, edits) !== candidate.text) {
    return rawResult(request, "invalid-edit-map", "needs-review");
  }
  // Independently account for the only authorized lexical deletions: recognized
  // mark names. Casing and punctuation must preserve the remaining word stream.
  const baseline = applyEdits(
    request.rawTranscript,
    edits.filter((edit) => edit.reason === "explicit-punctuation"),
  );
  const expected = lexicalTokens(baseline);
  const actual = lexicalTokens(candidate.text);
  if (
    expected.length !== actual.length ||
    expected.some((token, index) => token !== actual[index])
  ) {
    return rawResult(request, "lexical-change", "needs-review");
  }
  return {
    ...rawResult(request, "unchanged"),
    text: candidate.text,
    status: edits.length ? "refined" : "raw-fallback",
    edits,
    reasons: edits.length ? [] : ["unchanged"],
  };
}

/** Validate an untrusted edit result against the same immutable raw revision. */
export function validateDictationEdits(
  request: DictationRefinementRequest,
  candidate: unknown,
): DictationRefinementResult {
  const plan = prepare(request);
  return typeof plan === "string"
    ? rawResult(request, plan, plan === "incomplete-transcript" ? "unavailable" : "raw-fallback")
    : validate(request, candidate, plan);
}

/** Zero provider requests, no persistence, and no insertion authority. */
export function refineDictation(request: DictationRefinementRequest): DictationRefinementResult {
  const plan = prepare(request);
  if (typeof plan === "string") {
    return rawResult(
      request,
      plan,
      plan === "incomplete-transcript" ? "unavailable" : "raw-fallback",
    );
  }
  const candidate: Candidate = {
    schemaVersion: 1,
    policyVersion: 1,
    captureId: request.captureId,
    generation: request.generation,
    transcriptRevision: request.transcriptRevision,
    text: applyEdits(request.rawTranscript, plan.edits),
    edits: plan.edits,
  };
  return validate(request, candidate, plan);
}
