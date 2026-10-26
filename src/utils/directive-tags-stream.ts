import { findCodeOwnership } from "../shared/text/code-regions.js";
import { createConditionalTextProjector, type TextFilter } from "../shared/text/text-projection.js";
import { stripInlineDirectiveTagsForDisplay } from "./directive-tags-batch.js";

/** Raw offsets for literal directives whose Markdown code ownership is settled. */
export type StreamDirectiveCodePrefix = {
  end: number;
  checkedRawLength: number;
};

function hasDirectiveCodePrefixOpportunity(source: string, delta: string): boolean {
  if (!delta) {
    return false;
  }
  const deltaStart = source.length - delta.length;
  const start = Math.max(0, deltaStart - 4);
  let separator = -1;
  // A following line can close block code without a blank separator; ownership proves stability.
  for (const match of source.slice(start).matchAll(/(?:\r\n|\n|\r)[^\S\r\n]*\S/g)) {
    if (start + match.index + match[0].length > deltaStart) {
      separator = start + match.index;
    }
  }
  if (separator === -1) {
    return false;
  }
  const lastMarker = source.lastIndexOf("[[");
  return lastMarker !== -1 && separator > lastMarker;
}

export function findDirectiveCodePrefix(
  source: string,
  delta: string,
): StreamDirectiveCodePrefix | undefined {
  if (!hasDirectiveCodePrefixOpportunity(source, delta)) {
    return undefined;
  }
  const { regions, retainStart, completedParagraphs } = findCodeOwnership(source);
  let regionIndex = 0;
  let paragraphIndex = 0;
  let end = 0;
  for (
    let marker = source.indexOf("[[");
    marker !== -1;
    marker = source.indexOf("[[", marker + 1)
  ) {
    let region = regions[regionIndex];
    while (region && region.end <= marker) {
      region = regions[++regionIndex];
    }
    let paragraph = completedParagraphs[paragraphIndex];
    while (paragraph && paragraph.end <= marker) {
      paragraph = completedParagraphs[++paragraphIndex];
    }
    if (!region || region.start > marker || region.end < marker + 2) {
      return undefined;
    }
    if (region.block) {
      if (region.end > retainStart) {
        return undefined;
      }
      end = region.end;
      continue;
    }
    if (
      !paragraph ||
      paragraph.hasReferenceCandidate ||
      paragraph.start > region.start ||
      paragraph.end < region.end
    ) {
      return undefined;
    }
    end = paragraph.end;
  }
  return end ? { end, checkedRawLength: source.length } : undefined;
}

/** Retain only literal directives whose Markdown ownership cannot change on append. */
export const inlineDirectiveDisplayTextFilter: TextFilter = {
  transform: (text) => stripInlineDirectiveTagsForDisplay(text).text,
  create: () => {
    let prefix: StreamDirectiveCodePrefix | undefined;
    let hasMarker = false;
    let previousChar = "";
    let delta = "";
    return createConditionalTextProjector(
      (text) => {
        const projected = stripInlineDirectiveTagsForDisplay(text).text;
        prefix = projected === text ? findDirectiveCodePrefix(text, delta) : undefined;
        return projected;
      },
      (input) => {
        delta = input.delta ?? input.text;
        if ((previousChar + delta).includes("[[")) {
          hasMarker = true;
          prefix = undefined;
        }
        if (delta) {
          previousChar = delta.slice(-1);
        }
        return hasMarker && !prefix;
      },
    );
  },
};
