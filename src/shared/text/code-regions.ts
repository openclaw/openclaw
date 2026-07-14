// Code region helpers find fenced and inline code spans in Markdown text.
import { parseFenceSpans } from "../../../packages/markdown-core/src/fences.js";
export interface CodeRegion {
  start: number;
  end: number;
}

/** Finds fenced and inline Markdown code regions so text sanitizers can avoid examples. */
export function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = parseFenceSpans(text).map(({ start, end }) => ({ start, end }));

  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideFenced = regions.some((r) => start >= r.start && end <= r.end);
    if (!insideFenced) {
      regions.push({ start, end });
    }
  }

  regions.sort((a, b) => a.start - b.start);
  return regions;
}

/** Returns true when a character offset falls inside one of the discovered code regions. */
export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}
