import { buildCodeSpanIndex } from "../../packages/markdown-core/src/code-spans.js";
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
  const originalCode = buildCodeSpanIndex(params.original);
  const matches: Array<{ start: number; end: number }> = [];
  const orphanEnds: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = 0;
  // A non-greedy block regex stops at the first inner end marker and strands the outer tail.
  for (const marker of params.original.matchAll(markerPattern)) {
    if (originalCode.isInside(marker.index)) {
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
        const markerStart = marker.index + marker[0].indexOf(params.endMarker);
        orphanEnds.push({ start: markerStart, end: markerStart + params.endMarker.length });
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
