// Code region helpers find fenced and inline code spans in Markdown text.
import { parseCodeSpans } from "../../../packages/markdown-core/src/code-spans.js";
export interface CodeRegion {
  start: number;
  end: number;
}

/** Finds fenced and inline Markdown code regions so text sanitizers can avoid examples. */
export function findCodeRegions(text: string): CodeRegion[] {
  return parseCodeSpans(text).map(([start, end]) => ({ start, end }));
}

/** Returns true when a character offset falls inside one of the discovered code regions. */
export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}
