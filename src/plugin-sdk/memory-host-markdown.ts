import { findMarkdownCodeSpans } from "../../packages/markdown-core/src/reasoning-tags.js";
/**
 * Public SDK helpers for maintaining generated blocks inside Markdown files.
 */
import { escapeRegExp } from "../shared/regexp.js";

export type ManagedMarkdownBlockParams = {
  original: string;
  body: string;
  startMarker: string;
  endMarker: string;
  heading?: string;
  /** Enable trailing inline-end recovery only when the caller can identify unowned content. */
  recoverInlineOrphanEnds?: boolean;
  /** Original ranges excluded from managed-marker scanning and recovery (for example human Notes). */
  protectedRanges?: ReadonlyArray<{ start: number; end: number }>;
};

function isLineWhitespace(value: string): boolean {
  return /^[\t \r\n]*$/.test(value);
}

/** Ensures generated Markdown content ends with exactly the caller-provided body plus newline. */
export function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/**
 * Replaces balanced, standalone managed blocks with one current block, or appends it if missing.
 * With at least one balanced block, surplus end markers lose only their marker bytes;
 * they cannot establish ownership of the intervening prose. Missing ends still fail.
 */
export function replaceManagedMarkdownBlock(params: ManagedMarkdownBlockParams): string {
  const markerPattern = new RegExp(
    "^ {0,3}(" +
      escapeRegExp(params.startMarker) +
      "|" +
      escapeRegExp(params.endMarker) +
      ")[\\t ]*(?=\\r?$)",
    "gm",
  );
  const headingPrefix = params.heading ? params.heading + "\n" : "";
  const managedBlock =
    headingPrefix + params.startMarker + "\n" + params.body + "\n" + params.endMarker;
  const headingPattern = params.heading
    ? new RegExp(
        "(?:^|[\\r\\n])(" +
          escapeRegExp(params.heading) +
          "(?:[ \\t]*(?:\\r\\n|\\n|\\r))+[ \\t]*)$",
      )
    : undefined;
  const originalCode = findMarkdownCodeSpans(params.original);
  const isInOriginalCode = (offset: number) =>
    originalCode.some(([start, end]) => offset >= start && offset < end);
  const isProtected = (start: number, end: number) =>
    params.protectedRanges?.some((range) => start < range.end && end > range.start) ?? false;
  const matches: Array<{ start: number; end: number }> = [];
  const orphanEnds: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = 0;
  // A non-greedy block regex stops at the first inner end marker and strands the outer tail.
  for (const marker of params.original.matchAll(markerPattern)) {
    const markerText = marker[1];
    if (!markerText) {
      continue;
    }
    const markerStart = marker.index + marker[0].indexOf(markerText);
    if (
      isInOriginalCode(marker.index) ||
      isProtected(markerStart, markerStart + markerText.length)
    ) {
      continue;
    }
    if (marker[1] === params.startMarker) {
      if (depth === 0) {
        const heading = headingPattern?.exec(params.original.slice(0, marker.index));
        start = marker.index - (heading?.[1]?.length ?? 0);
      }
      depth += 1;
    } else {
      if (depth === 0) {
        const markerEnd = markerStart + params.endMarker.length;
        orphanEnds.push({ start: markerStart, end: markerEnd });
        continue;
      }
      if (depth === 1 && isProtected(start, marker.index + marker[0].length)) {
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        matches.push({ start, end: marker.index + marker[0].length });
      }
    }
  }
  if (depth !== 0) {
    throw new Error(
      "Unbalanced managed Markdown markers; restore the missing end marker before updating",
    );
  }
  if (orphanEnds.length > 0 && matches.length === 0) {
    throw new Error(
      "Unbalanced managed Markdown markers; restore the missing start marker before updating",
    );
  }

  if (matches.length > 0) {
    if (params.recoverInlineOrphanEnds) {
      // An inline end cannot close a block or claim prose. Recover only trailing
      // tokens concatenated to prose outside balanced blocks; preserve code and protected content.
      const inlineEndPattern = new RegExp(
        `${escapeRegExp(params.endMarker)}(?=[\\t ]*\\r?$)`,
        "gm",
      );
      for (const marker of params.original.matchAll(inlineEndPattern)) {
        const markerStart = marker.index;
        const lineStart = params.original.lastIndexOf("\n", markerStart - 1) + 1;
        const prefix = params.original.slice(lineStart, markerStart);
        if (
          isLineWhitespace(prefix) ||
          /\s|\\/.test(prefix.slice(-1)) ||
          prefix.includes(params.startMarker) ||
          isInOriginalCode(markerStart) ||
          matches.some((match) => markerStart >= match.start && markerStart < match.end) ||
          isProtected(markerStart, markerStart + params.endMarker.length)
        ) {
          continue;
        }
        orphanEnds.push({ start: markerStart, end: markerStart + params.endMarker.length });
      }
    }
    let updated = "";
    let lastEnd = 0;
    let inserted = false;
    const ranges = [
      ...matches.map((match) => ({ start: match.start, end: match.end, owned: true })),
      ...orphanEnds.map((match) => ({ start: match.start, end: match.end, owned: false })),
    ].toSorted((left, right) => left.start - right.start);
    for (const match of ranges) {
      const matchStart = match.start;
      const matchEnd = match.end;
      const betweenMatches = params.original.slice(lastEnd, matchStart);
      if (!match.owned) {
        updated += betweenMatches;
      } else if (!inserted) {
        updated += betweenMatches;
        updated += managedBlock;
        inserted = true;
      } else if (!isLineWhitespace(betweenMatches)) {
        updated += betweenMatches;
      }
      lastEnd = matchEnd;
    }
    return updated + params.original.slice(lastEnd);
  }

  const trimmed = params.original.trimEnd();
  if (trimmed.length === 0) {
    return managedBlock + "\n";
  }
  return trimmed + "\n\n" + managedBlock + "\n";
}
