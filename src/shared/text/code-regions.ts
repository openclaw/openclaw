import { expectDefined } from "@openclaw/normalization-core";
import {
  findMarkdownCodeRegions as findCodeRegions,
  parseMarkdownOwnership,
} from "../../../packages/markdown-core/src/reasoning-tags.js";

export { findCodeRegions };

/** Public range inputs need only offsets; parser-owned metadata belongs to discovered regions. */
export interface CodeRegion {
  start: number;
  end: number;
}

/** Index nonempty native parts using the visible text owner's newline separator. */
export function indexTextParts(parts: readonly string[]) {
  const spans: Array<{ index: number; start: number; end: number }> = [];
  const texts: string[] = [];
  let offset = 0;
  parts.forEach((part, index) => {
    if (!part) {
      return;
    }
    if (spans.length) {
      offset += 1;
    }
    const start = offset;
    texts.push(part);
    offset += part.length;
    spans.push({ index, start, end: offset });
  });
  return { text: texts.join("\n"), spans };
}

/** One canonical code scan for a stage's immutable native text parts. */
export function createTextPartCodeRegionResolver(parts: readonly string[]) {
  const source = indexTextParts(parts);
  const spans = new Map(source.spans.map((span) => [span.index, span]));
  let regions: ReturnType<typeof findCodeRegions> | undefined;
  return (index: number): ReturnType<typeof findCodeRegions> => {
    const span = spans.get(index);
    if (!span) {
      return [];
    }
    regions ??= findCodeRegions(source.text);
    let low = 0;
    let high = regions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (expectDefined(regions[middle], "indexed code region").end <= span.start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const result: ReturnType<typeof findCodeRegions> = [];
    for (let at = low; at < regions.length; at++) {
      const region = expectDefined(regions[at], "projected code region");
      if (region.start >= span.end) {
        break;
      }
      result.push({
        start: Math.max(0, region.start - span.start),
        end: Math.min(span.end, region.end) - span.start,
        block: region.block,
      });
    }
    return result;
  };
}

/** Canonical code ranges, stable-prefix boundary, and completed top-level paragraphs. */
export function findCodeOwnership(
  text: string,
  options?: Parameters<typeof parseMarkdownOwnership>[1],
) {
  const {
    regions,
    retainStart,
    completedParagraphs,
    paragraphs,
    definitions,
    textSpans,
    unsettledDefinitionStarts,
    unresolvedImageCodeStart,
  } = parseMarkdownOwnership(text, options);
  return {
    regions,
    retainStart,
    ...(unresolvedImageCodeStart === undefined ? {} : { unresolvedImageCodeStart }),
    completedParagraphs,
    definitions,
    textSpans,
    unsettledDefinitionStarts,
    ...(paragraphs ? { paragraphs } : {}),
  };
}

/** Reuse a parsed prefix only when an append cannot change Markdown ownership. */
export function canReuseMarkdownOwnership(
  previousText: string,
  nextText: string,
  ownership?: ReturnType<typeof findCodeOwnership>,
): boolean {
  if (!nextText.startsWith(previousText)) {
    return false;
  }
  const appended = nextText.slice(previousText.length);
  if (!appended) {
    return true;
  }
  const previousBoundary = previousText.slice(-4);
  const boundaryContext = previousBoundary + appended;
  const completesTableAlignment = appended.includes(":") && /-+[ \t]*$/u.test(previousBoundary);
  const completesShortTableAlignment =
    /(?:-{1,2}:|:-{1,2}|:-{1,2}:)(?=[ \t]*(?:\||\r?\n|\r|$))/u.test(boundaryContext);
  if (
    /[`~\t|]| {4}/u.test(boundaryContext) ||
    (/-{3,}/u.test(boundaryContext) && !/-{3,}/u.test(previousBoundary)) ||
    completesTableAlignment ||
    completesShortTableAlignment ||
    invalidatesGfmTableDelimiter(previousText, appended)
  ) {
    return false;
  }
  if (!ownership) {
    return true;
  }
  if (ownership.unsettledDefinitionStarts.length > 0) {
    return false;
  }

  // Image alt text can stop treating inline delimiters as code when its link closes.
  if (ownership.unresolvedImageCodeStart !== undefined && /[\x5b\x5d():]/u.test(appended)) {
    return false;
  }

  // Inline code inside a streamed link title stops being code when the title closes.
  if (
    ownership.retainStart < previousText.length &&
    completesInlineLinkTitle(previousText, nextText, ownership.retainStart)
  ) {
    return false;
  }

  // Unresolved image code can become alt text when a later reference definition arrives.
  let suffixStart = Math.max(0, previousText.length - 2005);
  const unresolvedImageCodeStart = ownership.unresolvedImageCodeStart;
  if (unresolvedImageCodeStart !== undefined && /[>\r\n]/u.test(appended)) {
    forEachReferenceDefinitionCandidate(previousText, (definitionStart) => {
      if (definitionStart >= unresolvedImageCodeStart) {
        // Labels may span several lines and destinations are unbounded. Keep the
        // complete candidate when a later append can close its destination.
        suffixStart = Math.min(suffixStart, definitionStart);
        return false;
      }
      return true;
    });
  }
  const suffix = previousText.slice(suffixStart) + appended;
  let unresolvedCandidate = false;
  forEachReferenceDefinitionCandidate(suffix, (candidateStart) => {
    const definitionStart = suffixStart + candidateStart;
    if (
      definitionStart < ownership.retainStart ||
      isInsideCode(definitionStart, ownership.regions)
    ) {
      return true;
    }
    const alreadyParsed = ownership.definitions.some(
      (definition) =>
        definition.start >= definitionStart && definition.start <= definitionStart + 3,
    );
    if (!alreadyParsed) {
      unresolvedCandidate = true;
      return false;
    }
    return true;
  });
  return !unresolvedCandidate;
}

function invalidatesGfmTableDelimiter(previousText: string, appended: string) {
  const appendedLineEnd = findLineEnd(appended, 0);
  if (appendedLineEnd === 0 || /^[ \t]*$/u.test(appended.slice(0, appendedLineEnd))) {
    return false;
  }

  const tailStart = Math.max(0, previousText.length - 2048);
  const tail = previousText.slice(tailStart);
  if (!/[-:|][ \t]*$/u.test(tail)) {
    return false;
  }
  const delimiterBreak = Math.max(tail.lastIndexOf("\r"), tail.lastIndexOf("\n"));
  if (delimiterBreak < 0) {
    return (
      tailStart > 0 &&
      /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u.test(
        stripBlockquotePrefixes(tail),
      )
    );
  }
  const delimiterStart = delimiterBreak + 1;
  const delimiterRow = stripBlockquotePrefixes(tail.slice(delimiterStart));
  if (!/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u.test(delimiterRow)) {
    return false;
  }

  const headerEnd =
    tail[delimiterBreak] === "\n" && tail[delimiterBreak - 1] === "\r"
      ? delimiterBreak - 1
      : delimiterBreak;
  const headerBreak = Math.max(
    tail.lastIndexOf("\r", headerEnd - 1),
    tail.lastIndexOf("\n", headerEnd - 1),
  );
  if (headerBreak < 0 && tailStart > 0) {
    return true;
  }
  return Boolean(stripBlockquotePrefixes(tail.slice(headerBreak + 1, headerEnd)).trim());
}

/** Visit possible definition labels at line starts without ambiguous regex backtracking. */
function forEachReferenceDefinitionCandidate(text: string, visit: (labelStart: number) => boolean) {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const lineEnd = findLineEnd(text, lineStart);
    const labelStart = findReferenceDefinitionLabelStart(text, lineStart, lineEnd);
    if (labelStart >= 0 && !hasReferenceDefinitionColon(text, labelStart)) {
      // This line has no complete definition label. Keep looking at later lines.
    } else if (labelStart >= 0 && !visit(labelStart)) {
      return;
    }

    if (lineEnd >= text.length) {
      return;
    }
    lineStart = lineEnd + (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? 2 : 1);
  }
}

function findLineEnd(text: string, start: number) {
  let index = start;
  while (index < text.length && text[index] !== "\r" && text[index] !== "\n") {
    index += 1;
  }
  return index;
}

function findReferenceDefinitionLabelStart(text: string, lineStart: number, lineEnd: number) {
  let cursor = lineStart;
  while (cursor < lineEnd) {
    let markerStart = cursor;
    while (markerStart < lineEnd && text[markerStart] === " ") {
      markerStart += 1;
    }
    if (markerStart - cursor > 3) {
      break;
    }

    if (text[markerStart] === ">") {
      cursor = markerStart + 1;
      if (text[cursor] === " " || text[cursor] === "\t") {
        cursor += 1;
      }
      continue;
    }

    const markerEnd = listMarkerEnd(text, markerStart, lineEnd);
    if (markerEnd > markerStart) {
      cursor = markerEnd;
      while (cursor < lineEnd && (text[cursor] === " " || text[cursor] === "\t")) {
        cursor += 1;
      }
      continue;
    }
    break;
  }

  while (cursor < lineEnd && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor += 1;
  }
  return text[cursor] === "[" ? cursor : -1;
}

function listMarkerEnd(text: string, start: number, lineEnd: number) {
  const first = text[start] ?? "";
  let markerEnd = start;
  if (first === "-" || first === "+" || first === "*") {
    markerEnd += 1;
  } else if (first >= "0" && first <= "9") {
    while (
      markerEnd < lineEnd &&
      (text[markerEnd] ?? "") >= "0" &&
      (text[markerEnd] ?? "") <= "9"
    ) {
      markerEnd += 1;
    }
    const delimiter = text[markerEnd] ?? "";
    if (markerEnd - start > 9 || (delimiter !== "." && delimiter !== ")")) {
      return start;
    }
    markerEnd += 1;
  } else {
    return start;
  }
  const trailingSpace = text[markerEnd];
  return trailingSpace === " " || trailingSpace === "\t" ? markerEnd : start;
}

function hasReferenceDefinitionColon(text: string, labelStart: number) {
  let cursor = labelStart + 1;
  let labelCharacters = 0;
  while (cursor < text.length && labelCharacters < 1999) {
    const codePoint = text.codePointAt(cursor);
    if (codePoint === undefined) {
      return false;
    }
    const width = codePoint > 0xffff ? 2 : 1;
    if (codePoint === 0x5d) {
      return labelCharacters > 0 && text[cursor + 1] === ":";
    }
    if (codePoint === 0x5c) {
      cursor += width;
      const escaped = text.codePointAt(cursor);
      if (escaped === undefined) {
        return false;
      }
      cursor += escaped > 0xffff ? 2 : 1;
    } else {
      cursor += width;
    }
    labelCharacters += 1;
  }
  return false;
}

function completesInlineLinkTitle(previousText: string, nextText: string, retainStart: number) {
  const appended = nextText.slice(previousText.length);
  const appendedBoundary = appended.includes(">") ? stripBlockquotePrefixes(appended) : appended;
  if (!/["']\s*\)|\)\s*\)|^\s*\)/u.test(appendedBoundary)) {
    return false;
  }
  const previousBoundary = trailingBlockquoteBoundary(previousText, 64);
  const closesAtBoundary =
    /["']\s*\)/u.test(appendedBoundary) ||
    (/["']\s*$/u.test(previousBoundary) && /^\s*\)/u.test(appendedBoundary)) ||
    /\)\s*\)/u.test(appendedBoundary) ||
    (/\)\s*$/u.test(previousBoundary) && /^\s*\)/u.test(appendedBoundary));
  if (!closesAtBoundary) {
    return false;
  }

  const sourceStart = Math.min(retainStart, previousText.length);
  const previousSource = previousText.slice(sourceStart);
  // Link destinations can contain balanced parentheses, and title whitespace
  // can cross a line ending. Keep this candidate scan permissive: false positives
  // only trigger a canonical ownership refresh.
  return /\]\([\s\S]*?\s["'(][\s\S]*$/u.test(previousSource);
}

export function stripBlockquotePrefixes(text: string) {
  return text.replace(/(^|\r\n|\n|\r)[ \t]*>(?:[ \t]{0,4}>)*[ \t]{0,3}/gu, "$1");
}

function trailingBlockquoteBoundary(text: string, limit: number) {
  const raw = text.slice(-limit * 8);
  return (raw.includes(">") ? stripBlockquotePrefixes(raw) : raw).slice(-limit);
}

export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((region) => pos >= region.start && pos < region.end);
}

/** Appends cannot revoke block code after its opening line; inline ownership can change. */
export function isInsideSettledBlockCode(
  pos: number,
  text: string,
  regions: ReturnType<typeof findCodeRegions>,
): boolean {
  return regions.some(
    (region) =>
      region.block &&
      region.start <= pos &&
      pos < region.end &&
      /[\r\n]/.test(text.slice(region.start, pos)),
  );
}

/** Removes control lines while retaining literal code and original line endings. */
export function stripLinesOutsideCode(
  text: string,
  shouldStrip: (line: string) => boolean,
): string {
  return projectLinesOutsideCode(text, shouldStrip, 0).text;
}

export function projectLinesOutsideCode(
  text: string,
  shouldStrip: (line: string) => boolean,
  retainStart: number,
) {
  let regions: CodeRegion[] | undefined;
  let retainedOutputStart = retainStart;
  const projected = text.replace(/[^\n]*(?:\n|$)/g, (raw: string, offset: number) => {
    const line = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw;
    if (!shouldStrip(line) || isInsideCode(offset, (regions ??= findCodeRegions(text)))) {
      return raw;
    }
    if (offset < retainStart) {
      retainedOutputStart -= raw.length;
    }
    return "";
  });
  return { text: projected, retainStart, retainedOutputStart };
}
