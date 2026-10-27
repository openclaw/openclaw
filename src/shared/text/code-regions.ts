import { scanFenceSpans } from "../../../packages/markdown-core/src/fences.js";
import {
  findMarkdownCodeRegions as findCodeRegions,
  parseMarkdownOwnership,
} from "../../../packages/markdown-core/src/reasoning-tags.js";
import {
  advanceProtectionScanState,
  createProtectionScanState,
} from "../../../packages/tool-call-repair/src/protection-fast-path.js";
import { isInsideCode } from "./code-ranges.js";

export { findCodeRegions };
export type { CodeRegion } from "./code-ranges.js";

export {
  createTextPartCodeRegionResolver,
  isInsideCode,
  isInsideSettledBlockCode,
  stripLinesOutsideCode,
  projectLinesOutsideCode,
} from "./code-ranges.js";

/** Canonical code ranges, stable-prefix boundary, and completed top-level paragraphs. */
export function findCodeOwnership(
  text: string,
  options?: Parameters<typeof parseMarkdownOwnership>[1],
) {
  const { codeSpans: _codeSpans, ...ownership } = parseMarkdownOwnership(text, options);
  return ownership;
}

/** Stable retained Markdown boundary and the context required to resume its tail. */
export function findTextCheckpoint(
  text: string,
  referenceLength: number,
  resolveOwnership: (text: string) => ReturnType<typeof findCodeOwnership>,
) {
  const state = createProtectionScanState();
  let cursor = referenceLength;
  let lastLineStart = cursor;
  let closedFence = false;
  for (let end = text.indexOf("\n", cursor); end !== -1; end = text.indexOf("\n", cursor)) {
    const line = text.slice(cursor, end + 1);
    const inFence = Boolean(state.fenceChar);
    advanceProtectionScanState(state, line);
    // References, image descriptions, and setext headings can need earlier paragraph context.
    if (
      state.paragraphAmbiguous ||
      state.structuralUnknown ||
      (!inFence && !state.fenceChar && /\[|^ {0,3}=+[ \t]*\r?\n$/.test(line))
    ) {
      const ownership = resolveOwnership(text);
      const retain = ownership.retainStart;
      let start = retain === 0 ? 0 : text.lastIndexOf("\n", retain - 1) + 1;
      const startsDefinition = ownership.definitions.some(
        (definition) =>
          definition.start >= start && /^[ \t]*$/.test(text.slice(start, definition.start)),
      );
      if (!startsDefinition) {
        const adjacentDefinition = ownership.definitions.findLast(
          (definition) =>
            definition.end <= start &&
            /^[ \t]*(?:\r\n|\r|\n)[ \t]*$/.test(text.slice(definition.end, start)),
        );
        // A synthetic blank after a definition would turn adjacent indented prose into code.
        if (adjacentDefinition) {
          start = text.lastIndexOf("\n", adjacentDefinition.start - 1) + 1;
        }
      }
      const completeEnd = text.lastIndexOf("\n") + 1;
      if (
        !/\r(?!\n)/.test(text) &&
        ownership.regions.some((region) => region.block && region.start === retain)
      ) {
        const fence = scanFenceSpans(text.slice(start, completeEnd)).state.open;
        if (fence) {
          return {
            offset: completeEnd,
            context: fence.marker + "\n",
            definitions: ownership.definitions,
          };
        }
      }
      return { offset: start, context: "", definitions: ownership.definitions };
    }
    lastLineStart = cursor;
    cursor = end + 1;
    closedFence = inFence && !state.fenceChar;
  }
  if (state.fenceChar) {
    // Only the proven top-level fence is carried; its settled body is never parsed again.
    return { offset: cursor, context: state.fenceChar.repeat(state.fenceLength) + "\n" };
  }
  return { offset: closedFence ? cursor : lastLineStart, context: "" };
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
  return canReuseMarkdownOwnershipForAppend(
    previousText,
    nextText.slice(previousText.length),
    ownership,
  );
}

/** Reuse a parsed prefix only when appending `appended` cannot change Markdown ownership. */
export function canReuseMarkdownOwnershipForAppend(
  previousText: string,
  appended: string,
  ownership?: ReturnType<typeof findCodeOwnership>,
): boolean {
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
    completesInlineLinkTitleForAppend(previousText, appended, ownership.retainStart)
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

function completesInlineLinkTitleForAppend(
  previousText: string,
  appended: string,
  retainStart: number,
) {
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

function stripBlockquotePrefixes(text: string) {
  return text.replace(/(^|\r\n|\n|\r)[ \t]*>(?:[ \t]{0,4}>)*[ \t]{0,3}/gu, "$1");
}

function trailingBlockquoteBoundary(text: string, limit: number) {
  const raw = text.slice(-limit * 8);
  return (raw.includes(">") ? stripBlockquotePrefixes(raw) : raw).slice(-limit);
}
