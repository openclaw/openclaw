import {
  REFINEMENT_LIMITS,
  RefinementError,
  type ProtectedSpan,
  type RefinementFailureCode,
  type RefinementModelAdapter,
  type RefinementProcessor,
  type RefinementRequest,
} from "./types.js";
import { applyRefinementEdits, freezeRefinementValue, refinementByteLength } from "./validation.js";

const stages = { intent: 0, deterministic: 1, prose: 2 };

export function supportsRefinementLocale(locale: string, supported: readonly string[]): boolean {
  const normalized = locale.toLowerCase();
  return supported.some(
    (entry) =>
      entry === "*" ||
      normalized === entry.toLowerCase() ||
      normalized.startsWith(`${entry.toLowerCase()}-`),
  );
}

/** Recognition only; this does not resolve files, grant permissions, or infer a mode. */
export function detectRefinementLiteralSpans(value: string): readonly ProtectedSpan[] {
  if (
    value.length > REFINEMENT_LIMITS.transcriptBytes ||
    refinementByteLength(value) > REFINEMENT_LIMITS.transcriptBytes
  ) {
    throw new RefinementError("payload-limit");
  }
  const matches: ProtectedSpan[] = [];
  const patterns = [
    /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*'/gu,
    /https?:\/\/[^\s<>"'`]+/gu,
    /[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+/gu,
    /\b[0-9a-fA-F]{16,}\b/gu,
    /(?:[A-Za-z]:\\|\.{0,2}\/)[^\s<>"'`]+/gu,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      matches.push({ start: match.index, end: match.index + match[0].length, kind: "literal" });
    }
  }
  if (!matches.length) {
    return freezeRefinementValue(matches);
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value);
  const merged: ProtectedSpan[] = [];
  for (const match of matches) {
    const first = graphemes.containing(match.start)!;
    const last = graphemes.containing(match.end - 1)!;
    const start = first.index;
    const end = last.index + last.segment.length;
    const previous = merged.at(-1);
    if (previous && start < previous.end) {
      merged[merged.length - 1] = { ...previous, end: Math.max(previous.end, end) };
    } else {
      merged.push({ start, end, kind: "literal" });
      if (merged.length > REFINEMENT_LIMITS.spans) {
        throw new RefinementError("payload-limit");
      }
    }
  }
  return freezeRefinementValue(merged);
}

/** The built-in path only trims outer whitespace. Code and prose interior bytes stay exact. */
export const whitespaceRefinementProcessor: RefinementProcessor = Object.freeze({
  id: "whitespace",
  stage: "deterministic",
  order: 0,
  modes: Object.freeze(["dictation"] as const),
  supportedLocales: Object.freeze(["*"]),
  transform(input, signal) {
    signal.throwIfAborted();
    const leading = /^\s+/u.exec(input.text)?.[0].length ?? 0;
    const trailing = /\s+$/u.exec(input.text)?.[0].length ?? 0;
    const edits: { start: number; end: number; text: string }[] = [];
    if (leading && !input.protectedSpans.some((span) => span.start < leading)) {
      edits.push({ start: 0, end: leading, text: "" });
    }
    if (
      trailing &&
      leading < input.text.length &&
      !input.protectedSpans.some((span) => span.end > input.text.length - trailing)
    ) {
      edits.push({ start: input.text.length - trailing, end: input.text.length, text: "" });
    }
    return {
      schemaVersion: 1,
      offsetUnit: "utf16",
      baseRevision: input.baseRevision,
      kind: "edits",
      edits,
    };
  },
});

export type RefinementPlan = Readonly<{
  request: RefinementRequest;
  text: string;
  protectedSpans: readonly ProtectedSpan[];
  processors: readonly RefinementProcessor[];
  model?: RefinementModelAdapter;
  modelInstructions: readonly string[];
  warnings: readonly RefinementFailureCode[];
}>;

/** Registration snapshots trusted adapter metadata; feature stores remain with their owners. */
export function registerRefinementProcessors(
  processors: readonly RefinementProcessor[],
): readonly RefinementProcessor[] {
  if (processors.length > REFINEMENT_LIMITS.processors) {
    throw new RefinementError("payload-limit");
  }
  const ids = new Set<string>();
  return freezeRefinementValue(
    processors.map((processor) => {
      if (
        !processor.id ||
        ids.has(processor.id) ||
        !Number.isSafeInteger(processor.order) ||
        !(processor.stage in stages) ||
        !processor.modes.length ||
        !processor.supportedLocales.length ||
        (!processor.transform && !processor.modelInstruction)
      ) {
        throw new RefinementError("invalid-request");
      }
      ids.add(processor.id);
      if (
        processor.modelInstruction &&
        refinementByteLength(processor.modelInstruction) > REFINEMENT_LIMITS.instructionBytes
      ) {
        throw new RefinementError("payload-limit");
      }
      return {
        ...processor,
        modes: [...processor.modes],
        supportedLocales: [...processor.supportedLocales],
      };
    }),
  );
}

export function compileRefinementPlan(
  request: RefinementRequest,
  registered: readonly RefinementProcessor[],
  model?: RefinementModelAdapter,
): RefinementPlan {
  const warnings: RefinementFailureCode[] = [];
  const processors: RefinementProcessor[] = [];
  for (const id of request.featurePolicy.processorIds) {
    const processor = registered.find((entry) => entry.id === id);
    if (!processor) {
      warnings.push("processor-unavailable");
    } else if (!processor.modes.includes(request.mode)) {
      warnings.push("unsupported-mode");
    } else if (!supportsRefinementLocale(request.locale.tag, processor.supportedLocales)) {
      warnings.push("unsupported-locale");
    } else {
      processors.push(processor);
    }
  }
  processors.sort(
    (a, b) =>
      stages[a.stage] - stages[b.stage] ||
      a.order - b.order ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const modelInstructions = processors.flatMap((processor) =>
    processor.modelInstruction ? [processor.modelInstruction] : [],
  );
  if (
    refinementByteLength(JSON.stringify(modelInstructions)) > REFINEMENT_LIMITS.instructionBytes
  ) {
    throw new RefinementError("payload-limit");
  }
  if (modelInstructions.length && request.providerPolicy.routeId === null) {
    throw new RefinementError("provider-unavailable");
  }
  if (request.providerPolicy.routeId !== null) {
    if (!model || model.id !== request.providerPolicy.routeId) {
      throw new RefinementError("provider-unavailable");
    }
    if (request.providerPolicy.locality === "strict-local" && model.locality !== "local") {
      throw new RefinementError("locality-denied");
    }
    if (!supportsRefinementLocale(request.locale.tag, model.supportedLocales)) {
      throw new RefinementError("unsupported-locale");
    }
  }
  const prepared = applyRefinementEdits(
    request.rawTranscript,
    request.authorizedEdits,
    request.protectedSpans,
  );
  const spans = [...prepared.protectedSpans];
  let delta = 0;
  for (const edit of request.authorizedEdits.toSorted((a, b) => a.start - b.start)) {
    if (edit.protection && edit.text.length) {
      spans.push({
        start: edit.start + delta,
        end: edit.start + delta + edit.text.length,
        ...edit.protection,
      });
    }
    delta += edit.text.length - (edit.end - edit.start);
  }
  spans.sort((a, b) => a.start - b.start);
  if (
    spans.length > REFINEMENT_LIMITS.spans ||
    refinementByteLength(JSON.stringify(request)) +
      refinementByteLength(JSON.stringify(modelInstructions)) >
      REFINEMENT_LIMITS.payloadBytes
  ) {
    throw new RefinementError("payload-limit");
  }
  return freezeRefinementValue({
    request,
    text: prepared.text,
    protectedSpans: spans,
    processors,
    ...(request.providerPolicy.routeId !== null && model
      ? { model: { ...model, supportedLocales: [...model.supportedLocales] } }
      : {}),
    modelInstructions,
    warnings,
  });
}
