import { expectDefined } from "@openclaw/normalization-core";
import { findMarkdownCodeRegions as findCodeRegions } from "../../../packages/markdown-core/src/markdown-code-regions.js";

export { findCodeRegions };

/** Public range inputs need only offsets; parser-owned metadata belongs to discovered regions. */
export interface CodeRegion {
  start: number;
  end: number;
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
