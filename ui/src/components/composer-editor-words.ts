import type { Line, Text } from "@codemirror/state";

type WordPart = { start: number; end: number; kind: "word" | "punctuation" | "space" };
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const partsByDocument = new WeakMap<Text, Map<number, readonly WordPart[]>>();

function wordParts(doc: Text, line: Line) {
  let lines = partsByDocument.get(doc);
  if (!lines) {
    lines = new Map();
    partsByDocument.set(doc, lines);
  }
  const cached = lines.get(line.number);
  if (cached) {
    return cached;
  }
  const parts: WordPart[] = [];
  const append = (start: number, end: number, kind: WordPart["kind"]) => {
    if (start === end) {
      return;
    }
    const previous = parts.at(-1);
    if (kind === "punctuation" && previous?.kind === kind && previous.end === start) {
      previous.end = end;
    } else {
      parts.push({ start, end, kind });
    }
  };
  for (const part of segmenter.segment(line.text)) {
    const { segment, index } = part;
    if (/^\s+$/u.test(segment)) {
      append(index, index + segment.length, "space");
    } else if (part.isWordLike) {
      // Native textbox word navigation separates dotted names, but keeps decimal
      // numbers and contractions together. ICU owns all other word boundaries.
      let start = 0;
      for (let at = 0; at < segment.length; at++) {
        if (
          segment[at] === "." &&
          !(/\p{N}/u.test(segment[at - 1] ?? "") && /\p{N}/u.test(segment[at + 1] ?? ""))
        ) {
          append(index + start, index + at, "word");
          append(index + at, index + at + 1, "punctuation");
          start = at + 1;
        }
      }
      append(index + start, index + segment.length, "word");
    } else {
      append(index, index + segment.length, "punctuation");
    }
  }
  lines.set(line.number, parts);
  return parts;
}

/** Read the authoritative line, including lines outside the rendered viewport. */
export function composerWordBoundary(doc: Text, position: number, forward: boolean) {
  const line = doc.lineAt(position);
  if (forward && position === line.to) {
    return Math.min(doc.length, position + 1);
  }
  if (!forward && position === line.from) {
    return Math.max(0, position - 1);
  }
  const localPosition = position - line.from;
  const parts = wordParts(doc, line);
  if (forward) {
    for (const part of parts) {
      if (part.end > localPosition && part.kind !== "space") {
        return line.from + part.end;
      }
    }
    return line.to;
  }
  const boundary = parts.findLast((part) => part.start < localPosition && part.kind !== "space");
  return line.from + (boundary?.start ?? 0);
}
