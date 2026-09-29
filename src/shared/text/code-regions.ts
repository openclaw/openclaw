// Code region helpers expose Markdown Core spans to sanitizer consumers.
import { expectDefined } from "@openclaw/normalization-core";
import {
  findMarkdownCodeRegions,
  parseMarkdownOwnership,
} from "../../../packages/markdown-core/src/reasoning-tags.js";

/** Public range inputs need only offsets; parser-owned metadata belongs to discovered regions. */
export interface CodeRegion {
  start: number;
  end: number;
}

/** Finds CommonMark block-aware fenced, indented, and inline code regions. */
export function findCodeRegions(
  text: string,
  options?: Parameters<typeof findMarkdownCodeRegions>[1],
): ReturnType<typeof findMarkdownCodeRegions> {
  return findMarkdownCodeRegions(text, options);
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
  const projected = new Map<number, ReturnType<typeof findCodeRegions>>();
  return (index: number): ReturnType<typeof findCodeRegions> => {
    const cached = projected.get(index);
    if (cached) {
      return cached;
    }
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
    projected.set(index, result);
    return result;
  };
}

/** Canonical code ranges, stable-prefix boundary, and completed top-level paragraphs. */
export function findCodeOwnership(
  text: string,
  options?: Parameters<typeof parseMarkdownOwnership>[1],
) {
  const { regions, retainStart, completedParagraphs, paragraphs } = parseMarkdownOwnership(
    text,
    options,
  );
  return {
    regions,
    retainStart,
    completedParagraphs,
    ...(paragraphs ? { paragraphs } : {}),
  };
}

/** Returns true when a character offset falls inside one of the discovered code regions. */
export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((region) => pos >= region.start && pos < region.end);
}

/** Removes control lines while retaining literal code and original line endings. */
export function stripLinesOutsideCode(
  text: string,
  shouldStrip: (line: string) => boolean,
): string {
  let regions: CodeRegion[] | undefined;
  return text.replace(/[^\n]*(?:\n|$)/g, (raw: string, offset: number) => {
    const line = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw;
    return shouldStrip(line) && !isInsideCode(offset, (regions ??= findCodeRegions(text)))
      ? ""
      : raw;
  });
}
