import {
  DICTATION_FORMATTING_LIMITS,
  type DictationMarkerCandidate,
  type DictationMarkerReason,
  type DictationRange,
} from "./types.ts";

const numberWords = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];
const markerReasons: Readonly<Record<string, DictationMarkerReason>> = {
  "new paragraph": "paragraph-break",
  "new line": "line-break",
  bullet: "bullet",
  "next item": "next-item",
  "start list": "list-start",
  "nested list": "nested-list",
  "end list": "list-end",
};

/** Shared lexical reader: recognized syntax does not establish command intent. */
export function readDictationMarker(text: string):
  | {
      reason: DictationMarkerReason;
      ordinal?: number;
    }
  | undefined {
  const phrase = text
    .toLowerCase()
    .replace(/[,:.]$/, "")
    .replace(/[ \t]+/g, " ");
  if (Object.hasOwn(markerReasons, phrase)) {
    return { reason: markerReasons[phrase]! };
  }
  if (!phrase.startsWith("step ")) {
    return undefined;
  }
  const number = phrase.slice(5);
  const ordinal = /^(?:0|[1-9]\d{0,8})$/.test(number)
    ? Number(number)
    : numberWords.indexOf(number);
  return ordinal >= 0 ? { reason: "numbered-item", ordinal } : undefined;
}

/** A CRLF is one line boundary, including when a match backtracks. */
export function dictationParagraphBreaks(text: string) {
  return text.matchAll(/(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r(?!\n)|\n)+/g);
}

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

/** Every unprotected command is reviewable; only exact confirmation supplies intent. */
export function dictationMarkerCandidates(
  text: string,
  protectedRanges: readonly DictationRange[],
): DictationMarkerCandidate[] | undefined {
  const candidates: DictationMarkerCandidate[] = [];
  const pattern =
    /(?<![\p{L}\p{N}_])(?:new[ \t]+paragraph|new[ \t]+line|next[ \t]+item|start[ \t]+list|nested[ \t]+list|end[ \t]+list|bullet|step[ \t]+(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))(?:[,:.])?(?=$|\s)/giu;
  for (const match of text.matchAll(pattern)) {
    const source = { start: match.index, end: match.index + match[0].length };
    if (protectedRanges.some((range) => range.start < source.end && range.end > source.start)) {
      continue;
    }
    const marker = readDictationMarker(match[0]);
    if (!marker) {
      continue;
    }
    if (candidates.length >= DICTATION_FORMATTING_LIMITS.confirmationCandidates) {
      return undefined;
    }
    candidates.push({ source, ...marker });
  }
  return candidates;
}
