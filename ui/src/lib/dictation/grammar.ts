import {
  DICTATION_FORMATTING_LIMITS,
  type DictationMarkerCandidate,
  type DictationRange,
} from "./types.ts";

/** Quotes, code and URLs remain inert even when a caller omits literal metadata. */
export function dictationLiteralRanges(text: string): DictationRange[] {
  const result: DictationRange[] = [];
  const tokens = /`+|~{3,}|["“‘']|(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu;
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const opening = token[0];
    if (opening === "'" && /[\p{L}\p{N}]/u.test(text[token.index - 1] ?? "")) {
      continue;
    }
    let end = tokens.lastIndex;
    if (opening.length === 1 && ['"', "“", "‘", "'"].includes(opening)) {
      const closing = opening === "“" ? "”" : opening === "‘" ? "’" : opening;
      end = text.length;
      for (let index = tokens.lastIndex; index < text.length; index++) {
        if (text[index] === "\\") {
          index++;
        } else if (
          text[index] === closing &&
          !(closing === "'" && /[\p{L}\p{N}]/u.test(text[index + 1] ?? ""))
        ) {
          end = index + 1;
          break;
        }
      }
    } else if (/^[`~]/.test(opening)) {
      const close = text.indexOf(opening, tokens.lastIndex);
      end = close < 0 ? text.length : close + opening.length;
    }
    result.push({ start: token.index, end });
    tokens.lastIndex = end;
  }
  return result;
}

/** Ordinary discussion cannot become a formatting operation, even via confirmation. */
export function ordinaryDictationMarker(text: string, source: DictationRange): boolean {
  const before = text.slice(0, source.start);
  const after = text.slice(source.end);
  const phrase = text.slice(source.start, source.end).toLowerCase();
  const nominalPhrase = /^(?:new[ \t]+(?:paragraph|line)|bullet|step[ \t])/.test(phrase);
  if (
    /\b(?:the|these|those|a|an)\s+(?:words?|phrase|term|literal|examples?|markers?|commands?)\b[^.!?\n]{0,80}$/i.test(
      before,
    ) ||
    /\b(?:words?|phrase|term|literal|named|called|saying|mention(?:ed|ing)?|markers?|commands?)\s*$/i.test(
      before,
    ) ||
    (nominalPhrase &&
      /\b(?:the|a|an|our|my|your|their|his|her|its|this|that|these|those|each|every|another|any|some|about|in|of|say|type|write|read|use|need|want|create|insert|discuss|discussed|delete)\s*$/i.test(
        before,
      )) ||
    /^\s*(?:is|are|means|appears|phrase|word|command|marker|symbol|character|syntax|spacing)\b/i.test(
      after,
    )
  ) {
    return true;
  }
  if (phrase.startsWith("bullet")) {
    if (
      /^\s*(?:trains?|proof|holes?|wounds?|journals?|points?|lists?|items?|formatting|shells?|casings?)\b/i.test(
        after,
      )
    ) {
      return true;
    }
    // A mid-sentence lone "bullet" has insufficient command intent. Explicit
    // list continuation or a list introduction makes the supported form clear.
    return (
      Boolean(before.trim()) && !/\bnext item\b/i.test(after) && !/\blist\s*[:.]?\s*$/i.test(before)
    );
  }
  return (
    phrase.startsWith("step ") &&
    /^\s*(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|point|decimal)\b/i.test(
      after,
    )
  );
}

/** Recognizer text does not carry acoustic pause or command-intent metadata. */
export function ambiguousDictationMarker(text: string, source: DictationRange): boolean {
  if (ordinaryDictationMarker(text, source)) {
    return true;
  }
  const phrase = text.slice(source.start, source.end).toLowerCase();
  if (!/^new[ \t]+(?:paragraph|line)/.test(phrase)) {
    return false;
  }
  const before = text.slice(0, source.start);
  const left = !before.trim() || /(?:\n|[.!?;:,])[ \t]*$/.test(before);
  const right = /[,:.]$/.test(phrase) || /^[ \t]*(?:\r?\n|$)/.test(text.slice(source.end));
  return !left || !right;
}

/** A bounded review proposal; an omitted/unchecked range remains literal text. */
export function dictationMarkerCandidates(
  text: string,
  protectedRanges: readonly DictationRange[],
): DictationMarkerCandidate[] | undefined {
  const candidates: DictationMarkerCandidate[] = [];
  const pattern = /(?<![\p{L}\p{N}_])new[ \t]+(?:paragraph|line)(?:[,:.])?(?=$|\s)/giu;
  for (const match of text.matchAll(pattern)) {
    const source = { start: match.index, end: match.index + match[0].length };
    if (
      protectedRanges.some((range) => range.start < source.end && range.end > source.start) ||
      ordinaryDictationMarker(text, source) ||
      !ambiguousDictationMarker(text, source)
    ) {
      continue;
    }
    if (candidates.length >= DICTATION_FORMATTING_LIMITS.confirmationCandidates) {
      return undefined;
    }
    candidates.push({
      source,
      reason: /paragraph/i.test(match[0]) ? "paragraph-break" : "line-break",
    });
  }
  return candidates;
}
