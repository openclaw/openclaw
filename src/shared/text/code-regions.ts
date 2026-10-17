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
  const {
    regions,
    retainStart,
    completedParagraphs,
    paragraphs,
    definitions,
    unsettledDefinitionStarts,
    unresolvedImageCodeStart,
  } = parseMarkdownOwnership(text, options);
  return {
    regions,
    retainStart,
    ...(unresolvedImageCodeStart === undefined ? {} : { unresolvedImageCodeStart }),
    completedParagraphs,
    definitions,
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
  const boundaryContext = previousText.slice(-3) + appended;
  if (/[`~\t]| {4}/u.test(boundaryContext)) {
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

  // Unresolved image code can become alt text when a later reference definition arrives.
  // The parser's retainStart marks the earliest source block whose ownership can still move.
  // Keep enough context for a definition prefix on the previous line whose
  // destination arrives on the next line.
  const suffixStart = Math.max(0, previousText.length - 2005);
  const suffix = previousText.slice(suffixStart) + appended;
  const referenceDefinitionCandidate =
    /(?:^|\r\n|\n|\r(?!\n)) {0,3}\x5b((?:\\[\s\S]|(?!\x5d)[\s\S]){1,1999})\x5d:[^\r\n]*(?=$|\r\n|\n|\r(?!\n))/gu;
  for (const match of suffix.matchAll(referenceDefinitionCandidate)) {
    const definitionStart = suffixStart + (match.index ?? 0) + match[0].indexOf("[");
    if (definitionStart < ownership.retainStart) {
      continue;
    }
    const alreadyParsed = ownership.definitions.some(
      (definition) =>
        definition.start >= definitionStart && definition.start <= definitionStart + 3,
    );
    if (!alreadyParsed) {
      return false;
    }
  }
  return true;
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
