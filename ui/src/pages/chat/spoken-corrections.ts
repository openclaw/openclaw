import {
  collectDictationProtectedSpans,
  DICTATION_REFINEMENT_LIMITS,
  dictationRangesOverlap,
  inspectDictationSource,
  validateDictationPlan,
  type DictationEdit,
  type DictationEditPlan,
  type DictationProtectedSpan,
  type DictationRange,
  type DictationRefinementPolicy,
  type DictationRefinementReason,
  type DictationRefinementResult,
  type DictationRefinementSource,
} from "./dictation-refinement.ts";

const days = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const units = "one|two|three|four|five|six|seven|eight|nine";
const small = `zero|${units}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen`;
const tens = `(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?: (?:${units}))?`;
const integral = `(?:(?:${units}) hundred(?: (?:and )?(?:${small}|${tens}))?|${small}|${tens})`;
const numberPhrase = new RegExp(
  `^(?:(?:minus|negative) )?${integral}(?: point (?:zero|${units})(?: (?:zero|${units}))*)?$`,
);
const numberWords = new Set(
  `${small}|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|point|decimal|minus|negative|plus|positive`.split(
    "|",
  ),
);
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
const numericToken = /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

type Value = { range: DictationRange; kind: "day" | "number"; text: string };
type Proposal = { edits: DictationEdit[]; reason?: DictationRefinementReason };

function valuesIn(text: string): Value[] {
  const tokens = [
    ...text.matchAll(/[+−-]?(?:\d+(?:\.\d+)?|\.\d+)|[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)?/gu),
  ];
  const values: Value[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const normalized = token[0].toLowerCase();
    const start = token.index;
    let end = start + token[0].length;
    if (
      /[\p{L}\p{M}\p{N}_]/u.test(text[start - 1] ?? "") ||
      /[\p{L}\p{M}\p{N}_]/u.test(text[end] ?? "")
    ) {
      continue;
    }
    if (days.has(normalized)) {
      values.push({ range: { start, end }, kind: "day", text: token[0] });
      continue;
    }
    if (!numberWords.has(normalized) && !numericToken.test(normalized)) {
      continue;
    }
    // A separated or unsupported sign belongs to the number, not surrounding
    // prose. Do not replace a trailing magnitude while retaining that sign.
    const unsupportedSign = /[+−-]\s*$/.test(text.slice(0, start));
    let tail = index;
    for (let next = tokens[tail + 1]; next; next = tokens[tail + 1]) {
      const word = next[0].toLowerCase();
      const after = tokens[tail + 2]?.[0].toLowerCase();
      if (
        !/^[\s-]+$/.test(text.slice(end, next.index)) ||
        (!numberWords.has(word) &&
          !numericToken.test(word) &&
          !(word === "and" && after && (numberWords.has(after) || numericToken.test(after))))
      ) {
        break;
      }
      tail += 1;
      end = next.index + next[0].length;
    }
    const value = text.slice(start, end);
    if (
      !unsupportedSign &&
      (/^[+-]?\d+(?:\.\d+)?$/.test(value) ||
        numberPhrase.test(value.toLowerCase().replace(/[-\s]+/g, " "))) &&
      !/[\p{L}\p{M}\p{N}_]/u.test(text[end] ?? "")
    ) {
      values.push({ range: { start, end }, kind: "number", text: value });
    }
    // An unsupported number phrase must not degrade to its trailing number.
    index = tail;
  }
  return values;
}

function sentenceStart(text: string, offset: number): number {
  let start = 0;
  for (const sentence of sentences.segment(text)) {
    if (sentence.index > offset) {
      break;
    }
    start = sentence.index;
  }
  return start;
}

function protectedRange(spans: readonly DictationProtectedSpan[], value: DictationRange): boolean {
  return spans.some((span) => dictationRangesOverlap(span.range, value));
}

function edit(
  range: DictationRange,
  replacement: string,
  triggerRange: DictationRange,
  category: DictationEdit["category"],
): DictationEdit {
  return {
    id: `${category}:${range.start}:${triggerRange.start}`,
    sourceSpanId: `range:${range.start}:${range.end}`,
    range,
    replacement,
    triggerRange,
    category,
    chainDepth: 1,
  };
}

/** These cues describe words or a hypothetical edit, rather than making one. */
function describesWords(prefix: string): boolean {
  return /\b(?:said|says?|say|word|phrase|example|literal|type|print|means?)\b|\b(?:do not|don't|never|not|might|would|could|should|will|can|may)\s*$/iu.test(
    prefix,
  );
}

function proposeCorrections(
  source: DictationRefinementSource,
  protection: readonly DictationProtectedSpan[],
): Proposal {
  const text = source.text;
  const values = valuesIn(text);
  const edits: DictationEdit[] = [];
  const markers = [...text.matchAll(/\b(?:no|sorry|actually)\b/giu)].filter(
    (marker) =>
      !protectedRange(protection, { start: marker.index, end: marker.index + marker[0].length }),
  );
  if (markers.length > DICTATION_REFINEMENT_LIMITS.edits * DICTATION_REFINEMENT_LIMITS.chainDepth) {
    return { edits: [], reason: "plan-too-large" };
  }
  for (const marker of markers) {
    const markerRange = { start: marker.index, end: marker.index + marker[0].length };
    const left = values.findLast((value) => value.range.end <= markerRange.start);
    const right = values.find((value) => value.range.start >= markerRange.end);
    if (
      !left ||
      !right ||
      left.kind !== right.kind ||
      !/^[\s,]*$/.test(text.slice(left.range.end, markerRange.start)) ||
      !/^[\s,]*$/.test(text.slice(markerRange.end, right.range.start))
    ) {
      continue;
    }
    const consumed = { start: left.range.start, end: right.range.end };
    if (protectedRange(protection, consumed)) {
      continue;
    }
    const start = sentenceStart(text, left.range.start);
    if (describesWords(text.slice(start, left.range.start))) {
      return { edits: [], reason: "uncertain-scope" };
    }
    const previous = edits.find(
      (item) => item.category === "replacement" && item.range.end === left.range.end,
    );
    if (previous) {
      previous.range.end = right.range.end;
      previous.sourceSpanId = `range:${previous.range.start}:${previous.range.end}`;
      previous.replacement = right.text;
      previous.triggerRange.end = markerRange.end;
      previous.chainDepth += 1;
      if (previous.chainDepth > DICTATION_REFINEMENT_LIMITS.chainDepth) {
        return { edits: [], reason: "chain-limit" };
      }
      continue;
    }
    // Adjacency supplies grammar, not ownership: all same-kind values in this
    // owned sentence must identify the same unique source target.
    const targets = values.filter(
      (value) =>
        value.kind === left.kind &&
        value.range.start >= start &&
        value.range.end <= markerRange.start &&
        !protectedRange(protection, value.range),
    );
    if (targets.length !== 1) {
      return { edits: [], reason: "ambiguous-target" };
    }
    edits.push(edit(consumed, right.text, markerRange, "replacement"));
  }

  // Explicit named replacement deliberately supports one word, not pronouns or
  // unbounded prose. The source occurrence must precede the spoken request.
  const change =
    /\bchange\s+([\p{L}\p{M}][\p{L}\p{M}'’-]{0,39})\s+to\s+([\p{L}\p{M}][\p{L}\p{M}'’-]{0,39})(?=\s*[.!?]?\s*$)/iu.exec(
      text,
    );
  if (change) {
    const triggerRange = { start: change.index, end: change.index + change[0].length };
    if (!protectedRange(protection, triggerRange)) {
      const prefix = text.slice(0, change.index);
      if (describesWords(prefix.slice(sentenceStart(text, change.index)))) {
        return { edits: [], reason: "uncertain-scope" };
      }
      const targets = [...prefix.matchAll(/[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu)]
        .filter((word) => word[0].toLowerCase() === change[1]!.toLowerCase())
        .map((word) => ({ start: word.index, end: word.index + word[0].length }));
      if (targets.length !== 1) {
        return { edits: [], reason: targets.length ? "ambiguous-target" : "no-target" };
      }
      const target = targets[0]!;
      if (protectedRange(protection, target)) {
        return { edits: [], reason: "protected-span" };
      }
      edits.push(edit(target, change[2]!, triggerRange, "replacement"));
      const whitespace = /\s*$/.exec(prefix)?.[0].length ?? 0;
      edits.push(
        edit(
          { start: change.index - whitespace, end: text.length },
          "",
          triggerRange,
          "replacement",
        ),
      );
    }
  }

  const retractions = [...text.matchAll(/\bscratch\s+that\s+last\s+sentence\b/giu)];
  const restarts = [...text.matchAll(/\brestart\s+this\s+sentence\b/giu)];
  for (const command of [...retractions, ...restarts].toSorted((a, b) => a.index - b.index)) {
    const triggerRange = { start: command.index, end: command.index + command[0].length };
    if (protectedRange(protection, triggerRange)) {
      continue;
    }
    const prefix = text.slice(0, command.index).trimEnd();
    const retract = /^scratch/iu.test(command[0]);
    const suffix = text.slice(triggerRange.end);
    if ((retract && !/^\s*[.!?]?\s*$/.test(suffix)) || (!retract && !suffix.trim())) {
      return { edits: [], reason: "uncertain-scope" };
    }
    let start: number;
    if (retract) {
      if (!/[.!?]$/.test(prefix)) {
        return { edits: [], reason: "no-target" };
      }
      const last = [...sentences.segment(prefix)].at(-1);
      if (!last || !/[\p{L}\p{N}]/u.test(last.segment)) {
        return { edits: [], reason: "no-target" };
      }
      start = last.index;
    } else {
      start = sentenceStart(prefix, prefix.length);
      if (!prefix.slice(start).trim() || /[.!?]$/.test(prefix)) {
        return { edits: [], reason: "no-target" };
      }
      if (
        describesWords(prefix.slice(start)) ||
        prefix.length - start > 512 ||
        suffix.length > 512
      ) {
        return { edits: [], reason: "uncertain-scope" };
      }
    }
    while (start > 0 && /\s/.test(text[start - 1]!)) {
      start -= 1;
    }
    const range = { start, end: text.length };
    if (protectedRange(protection, range)) {
      return { edits: [], reason: "protected-span" };
    }
    const replacement = retract ? "" : `${start > 0 ? " " : ""}${suffix.trim()}`;
    const next = edit(range, replacement, triggerRange, retract ? "retraction" : "restart");
    // A later explicit restart/retraction replaces an earlier correction of the
    // same owned sentence. Resolve against source ranges, never shifted text.
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const prior = edits[index]!;
      if (range.start <= prior.range.start && prior.range.end <= range.end) {
        next.chainDepth += prior.chainDepth;
        edits.splice(index, 1);
      }
    }
    edits.push(next);
  }
  return { edits };
}

/** One local semantic pass. It neither selects a provider nor invokes a tool. */
export function prepareDictationRefinement(
  source: DictationRefinementSource,
  policy: DictationRefinementPolicy,
): DictationRefinementResult {
  const preserve = (
    reason?: DictationRefinementReason,
    status: DictationRefinementResult["status"] = "unchanged",
  ): DictationRefinementResult => ({
    status,
    original: source.text,
    candidate: source.text,
    plan: null,
    reasons: reason ? [reason] : [],
  });
  if (policy.mode !== "explicit") {
    return preserve("off");
  }
  if (policy.literal) {
    return preserve("literal");
  }
  if (!/^en(?:-US)?$/i.test(source.locale)) {
    return preserve("unsupported-locale", "unavailable");
  }
  if (!source.isFinal) {
    return preserve("not-final", "needs-review");
  }
  const sourceReason = inspectDictationSource(source);
  if (sourceReason && sourceReason !== "metadata-incomplete") {
    return preserve(sourceReason, "needs-review");
  }
  if ((source.protectedSpans?.length ?? 0) > DICTATION_REFINEMENT_LIMITS.spans) {
    return preserve("plan-too-large", "needs-review");
  }
  const protectedSpans = collectDictationProtectedSpans(source);
  if (protectedSpans.length > DICTATION_REFINEMENT_LIMITS.spans) {
    return preserve("plan-too-large", "needs-review");
  }
  const proposal = proposeCorrections(source, protectedSpans);
  if (proposal.reason) {
    return preserve(proposal.reason, "needs-review");
  }
  if (!proposal.edits.length) {
    return preserve();
  }
  const plan: DictationEditPlan = {
    schemaVersion: 1,
    grammarVersion: "en-explicit-v1",
    captureToken: source.captureToken,
    revision: source.revision,
    sourceText: source.text,
    ambiguity: "unique",
    edits: proposal.edits,
    protectedSpans,
  };
  const validation = validateDictationPlan(source, plan);
  if (!validation.ok) {
    return preserve(validation.reason, "needs-review");
  }
  return {
    status: "needs-review",
    original: source.text,
    candidate: validation.candidate,
    plan,
    reasons: [sourceReason ?? "review-required"],
  };
}
