import remend, { type RemendOptions } from "remend";
import {
  findMarkdownCodeSpans,
  findMarkdownCodeRegions,
} from "../../../packages/markdown-core/src/reasoning-tags.js";
import {
  consumeMarkdownRawHtmlLine,
  findMarkdownRawHtmlRanges,
  walkMarkdownDisclosureTags,
  type MarkdownDetailsFrame,
  scanMarkdownDisclosureLine,
} from "./markdown-details.ts";
import { createMarkdownParser } from "./markdown-parser.ts";

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FENCE_CONTAINER_PREFIX_RE = /^[ \t]{0,3}(?:(?:>\s?)|(?:(?:[-+*]|\d{1,9}[.)])[ \t]+))/;
const LIST_ITEM_OPEN_RE = /^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/u;
const LINK_REFERENCE_CANDIDATE_RE = /^[ \t]*\[/u;
const DISCLOSURE_LINE_CANDIDATE_RE = /^[ \t]*<\/?(?:details|summary)(?=[\s>])/iu;
const STREAMING_SPLIT_CACHE_LIMIT = 8;

type FenceMarker = { length: number; marker: "`" | "~" };
type StrippedMarkdownLine = { content: string; offset: number };

function stripMarkdownContainerPrefixes(line: string): StrippedMarkdownLine {
  let current = line;
  let offset = 0;
  for (let index = 0; index < 8; index += 1) {
    const match = FENCE_CONTAINER_PREFIX_RE.exec(current)?.[0];
    if (!match) {
      return { content: current, offset };
    }
    current = current.slice(match.length);
    offset += match.length;
  }
  return { content: current, offset };
}

function getFenceMarker(line: string): FenceMarker | null {
  const fence = FENCE_OPEN_RE.exec(stripMarkdownContainerPrefixes(line).content)?.[1];
  return fence ? { length: fence.length, marker: fence.charAt(0) as FenceMarker["marker"] } : null;
}

function isFenceClose(line: string, fence: FenceMarker): boolean {
  const trimmed = stripMarkdownContainerPrefixes(line).content.trimEnd();
  const match = FENCE_OPEN_RE.exec(trimmed);
  const marker = match?.[1];
  if (!match || !marker) {
    return false;
  }
  return (
    marker.charAt(0) === fence.marker &&
    marker.length >= fence.length &&
    trimmed.slice(match[0].length).trim() === ""
  );
}

function updateDetailsStack(
  line: string,
  stack: MarkdownDetailsFrame[],
  allowPendingSummary: boolean,
  codeSpans: ReadonlyArray<readonly [number, number]>,
  lineOffset: number,
): boolean {
  const stripped = stripMarkdownContainerPrefixes(line);
  const tags = scanMarkdownDisclosureLine(
    stripped.content,
    codeSpans,
    lineOffset + stripped.offset,
  );
  return tags ? walkMarkdownDisclosureTags(tags, stack, { allowPendingSummary }) : false;
}

type StreamingMarkdownSplit = {
  /** Offset just past the last blank line outside a fence/details block; the prefix is stable. */
  boundary: number;
  /** Absolute offset where remend may start, or null while a fence remains open. */
  tailRepairStart: number | null;
};

type StreamingMarkdownCursor = {
  boundary: number;
  firstListOffset: number | null;
  hasLinkReferenceDefinition: boolean;
  index: number;
  lastLiteralOffset: number;
  lineMode: "fence" | "plain" | null;
  openFence: FenceMarker | null;
};

type StreamingMarkdownCacheEntry = {
  cursor: StreamingMarkdownCursor;
  markdown: string;
  rawTail: boolean;
  result: StreamingMarkdownSplit;
};

// A reused row key does not imply append-only text: rollovers, snapshots, and
// completed citation markers can all replace the normalized Markdown prefix.
const streamingSplitCache = new Map<string, StreamingMarkdownCacheEntry>();

function findStreamingCodeSpans(markdown: string, start: number): Array<[number, number]> {
  return findMarkdownCodeSpans(markdown.slice(start)).map(([from, to]) => [
    from + start,
    to + start,
  ]);
}

let rawHtmlParser: ReturnType<typeof createMarkdownParser> | undefined;

function createStreamingRawHtmlScanner(
  markdown: string,
  start: number,
  getCodeSpans: () => ReadonlyArray<readonly [number, number]>,
) {
  let ranges: Array<[number, number]> | undefined;
  let current = 0;
  return (line: string, index: number) => {
    const stripped = stripMarkdownContainerPrefixes(line);
    if (
      !ranges &&
      stripped.content.trimStart().startsWith("<") &&
      consumeMarkdownRawHtmlLine(
        stripped.content,
        { context: null },
        getCodeSpans(),
        index + stripped.offset,
      )
    ) {
      ranges = findMarkdownRawHtmlRanges(
        markdown.slice(start),
        (rawHtmlParser ??= createMarkdownParser()),
      ).map(([from, to]) => [from + start, to + start]);
    }
    let range = ranges?.[current];
    while (range && range[1] <= index) {
      current += 1;
      range = ranges?.[current];
    }
    return range && range[0] <= index && index < range[1] ? range : undefined;
  };
}

function scanStableStreamingMarkdown(
  markdownLocal: string,
  cursor: StreamingMarkdownCursor = {
    boundary: 0,
    firstListOffset: null,
    hasLinkReferenceDefinition: false,
    index: 0,
    lastLiteralOffset: 0,
    lineMode: null,
    openFence: null,
  },
): { cursor: StreamingMarkdownCursor; rawTail: boolean; result: StreamingMarkdownSplit } {
  let { boundary, firstListOffset, hasLinkReferenceDefinition, index, lastLiteralOffset } = cursor;
  let lineMode = cursor.lineMode;
  let openFence = cursor.openFence;
  const detailsStack: MarkdownDetailsFrame[] = [];
  // Completed literal blocks cannot gain indentation ownership from later prose. Keep
  // list containers and unfinished fences intact when parsing the retained suffix.
  const codeStart = cursor.openFence
    ? 0
    : Math.min(cursor.lastLiteralOffset, cursor.firstListOffset ?? cursor.lastLiteralOffset);
  const codeInput = markdownLocal.slice(codeStart);
  const codeRegions = / {4}|\t/u.test(codeInput)
    ? findMarkdownCodeRegions(codeInput).map((region) => ({
        start: region.start + codeStart,
        end: region.end + codeStart,
        block: region.block,
      }))
    : [];
  let codeSpans: ReturnType<typeof findMarkdownCodeSpans> | undefined = codeRegions.length
    ? codeRegions.map(({ start, end }) => [start, end])
    : undefined;
  const findRawHtmlRange = createStreamingRawHtmlScanner(
    markdownLocal,
    Math.min(cursor.boundary, cursor.firstListOffset ?? cursor.boundary),
    () => (codeSpans ??= findStreamingCodeSpans(markdownLocal, firstListOffset ?? boundary)),
  );
  let resumeCursor = cursor;
  let rawTail = false;

  while (index < markdownLocal.length) {
    const nextLineBreak = markdownLocal.indexOf("\n", index);
    const lineEnd = nextLineBreak === -1 ? markdownLocal.length : nextLineBreak + 1;
    if (lineMode) {
      index = lineEnd;
      lineMode = nextLineBreak === -1 ? lineMode : null;
      resumeCursor = {
        boundary,
        firstListOffset,
        hasLinkReferenceDefinition,
        index,
        lastLiteralOffset,
        lineMode,
        openFence,
      };
      continue;
    }
    const line = markdownLocal.slice(index, nextLineBreak === -1 ? lineEnd : nextLineBreak);
    const lineFence = openFence;
    let rawHtmlLine = false;

    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
        lastLiteralOffset = lineEnd;
        if (detailsStack.length === 0) {
          boundary = lineEnd;
        }
      }
    } else {
      const strippedLine = stripMarkdownContainerPrefixes(line);
      const rawHtmlRange = findRawHtmlRange(line, index);
      rawHtmlLine = rawHtmlRange !== undefined;
      if (
        firstListOffset === null &&
        LIST_ITEM_OPEN_RE.test(line) &&
        (!rawHtmlRange || rawHtmlRange[0] === index)
      ) {
        // A list also retains the disclosure that contains it.
        firstListOffset = detailsStack.length > 0 ? boundary : index;
      }
      if (rawHtmlLine) {
        lastLiteralOffset = lineEnd;
        const content = strippedLine.content.trimStart();
        rawTail = nextLineBreak === -1 && content.length > 0 && !content.startsWith("<");
      } else {
        const openingFence = getFenceMarker(line);
        if (openingFence) {
          openFence = openingFence;
          lastLiteralOffset = lineEnd;
        } else {
          if (DISCLOSURE_LINE_CANDIDATE_RE.test(strippedLine.content)) {
            updateDetailsStack(
              line,
              detailsStack,
              false,
              (codeSpans ??= findStreamingCodeSpans(markdownLocal, firstListOffset ?? boundary)),
              index,
            );
          }
          if (detailsStack.length === 0) {
            if (LINK_REFERENCE_CANDIDATE_RE.test(strippedLine.content)) {
              hasLinkReferenceDefinition = true;
            }
            if (line.trim() === "") {
              boundary = lineEnd;
            }
          }
        }
      }
    }
    index = lineEnd;
    // A raw token at EOF can extend on append; resume only after a later nonliteral line.
    if (
      detailsStack.length === 0 &&
      !rawHtmlLine &&
      (nextLineBreak !== -1 || canResumeStreamingLine(line, lineFence))
    ) {
      lineMode = nextLineBreak === -1 ? (lineFence ? "fence" : "plain") : null;
      resumeCursor = {
        boundary,
        firstListOffset,
        hasLinkReferenceDefinition,
        index,
        lastLiteralOffset,
        lineMode,
        openFence,
      };
    }
  }

  // A bracket-leading line can start a multiline or escaped reference label.
  // Keep its complete document together rather than guessing label boundaries.
  if (hasLinkReferenceDefinition) {
    boundary = 0;
  } else if (firstListOffset !== null) {
    // Blank lines cannot prove a list has ended: loose items, continuation
    // indentation, and nested blocks all share the original list container.
    boundary = Math.min(boundary, firstListOffset);
  }

  // Blank lines inside indented code do not retire the block, and prose repair
  // must never complete punctuation in any parser-owned code block.
  let lastLiteralEnd = lastLiteralOffset;
  for (const region of codeRegions) {
    if (!region.block) {
      continue;
    }
    if (region.start < boundary && boundary < region.end) {
      boundary = region.start;
    }
    lastLiteralEnd = Math.max(lastLiteralEnd, region.end);
  }

  return {
    cursor: resumeCursor,
    rawTail,
    result: {
      boundary,
      tailRepairStart: openFence ? null : Math.max(boundary, lastLiteralEnd),
    },
  };
}

function canResumeStreamingLine(line: string, fence: FenceMarker | null): boolean {
  const first = stripMarkdownContainerPrefixes(line).content.charAt(0);
  if (!first) {
    return false;
  }
  return fence ? first !== fence.marker : !/[\s`~<[\]*+\-\d>]/u.test(first);
}

export function splitStableStreamingMarkdown(
  markdownLocal: string,
  streamKey?: string,
  stablePrefixLength = markdownLocal.length,
): StreamingMarkdownSplit {
  if (!streamKey) {
    return scanStableStreamingMarkdown(markdownLocal).result;
  }
  const stableMarkdown = markdownLocal.slice(0, stablePrefixLength);
  const cached = streamingSplitCache.get(streamKey);
  const append = cached && stableMarkdown.startsWith(cached.markdown);
  // Appending within an established literal line cannot change its container.
  // A new line or an ambiguous opener goes back through the native block parser.
  const scanned =
    append && cached.rawTail && !/[\r\n]/u.test(stableMarkdown.slice(cached.markdown.length))
      ? {
          cursor: cached.cursor,
          rawTail: true,
          result: { boundary: cached.result.boundary, tailRepairStart: stableMarkdown.length },
        }
      : scanStableStreamingMarkdown(stableMarkdown, append ? cached.cursor : undefined);
  streamingSplitCache.delete(streamKey);
  streamingSplitCache.set(streamKey, { ...scanned, markdown: stableMarkdown });
  while (streamingSplitCache.size > STREAMING_SPLIT_CACHE_LIMIT) {
    const oldest = streamingSplitCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    streamingSplitCache.delete(oldest);
  }
  // Truncation notices change on every chunk even after their capped content is
  // fixed; retain the immutable checkpoint and rescan only that short suffix.
  return stablePrefixLength === markdownLocal.length
    ? scanned.result
    : scanStableStreamingMarkdown(markdownLocal, scanned.cursor).result;
}

// Streaming-tail repair config: math is not rendered by this pipeline, so
// completing `$$` would inject visible characters into ordinary prose.
const streamingRemendOptions = { katex: false, linkMode: "text-only" } satisfies RemendOptions;

// repairStart is the splitter-owned literal boundary relative to this tail.
export function repairStreamingMarkdownTail(tail: string, repairStart: number): string {
  if (repairStart === tail.length) {
    return tail;
  }
  const repaired =
    tail.slice(0, repairStart) + remend(tail.slice(repairStart), streamingRemendOptions);
  if (!repaired.includes("<")) {
    return repaired;
  }
  const detailsStack: MarkdownDetailsFrame[] = [];
  const codeSpans = findMarkdownCodeSpans(repaired);
  const findRawHtmlRange = createStreamingRawHtmlScanner(
    tail.slice(0, repairStart),
    0,
    () => codeSpans,
  );
  let openFence: FenceMarker | null = null;
  let pendingSummary = false;
  let index = 0;
  while (index < repaired.length) {
    const nextLineBreak = repaired.indexOf("\n", index);
    const lineEnd = nextLineBreak === -1 ? repaired.length : nextLineBreak + 1;
    const line = repaired.slice(index, nextLineBreak === -1 ? lineEnd : nextLineBreak);
    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
      }
    } else if (!findRawHtmlRange(line, index)) {
      openFence = getFenceMarker(line);
      if (!openFence) {
        pendingSummary = updateDetailsStack(
          line,
          detailsStack,
          nextLineBreak === -1,
          codeSpans,
          index,
        );
      }
    }
    index = lineEnd;
  }
  return pendingSummary ? `${repaired}</summary>` : repaired;
}
