export { findMarkdownCodeRegions as findCodeRegions } from "../../../packages/markdown-core/src/markdown-code-regions.js";
import { findMarkdownCodeRegions as findCodeRegions } from "../../../packages/markdown-core/src/markdown-code-regions.js";

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
