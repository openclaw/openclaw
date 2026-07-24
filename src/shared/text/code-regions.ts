// Code region helpers find fenced and inline code spans in Markdown text.
import { expectDefined } from "@openclaw/normalization-core";
export interface CodeRegion {
  start: number;
  end: number;
}

/** Finds fenced and inline Markdown code regions so text sanitizers can avoid examples. */
export function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2|$)/g;
  for (const match of text.matchAll(fencedRe)) {
    const start =
      (match.index ?? 0) + expectDefined(match[1], "code regions regex capture 1").length;
    regions.push({
      start,
      end: start + match[0].length - expectDefined(match[1], "code regions regex capture 1").length,
    });
  }

  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // Per CommonMark 0.31.2, opening and closing backtick runs must have
    // equal length. Skip mismatched runs — they are not valid code spans.
    const openingLen = (match[0].match(/^`+/) || [""])[0].length;
    const closingLen = (match[0].match(/`+$/) || [""])[0].length;
    if (openingLen !== closingLen) {
      continue;
    }
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
