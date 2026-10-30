import { skipWhitespace } from "../../../packages/tool-call-repair/src/grammar.js";
import { findCodeRegions } from "./code-ranges.js";
import { createTagNameProbe } from "./tag-name-probe.js";
import { createConditionalTextProjector, type TextFilter } from "./text-projection.js";

type FinalTagMatch = {
  index: number;
  text: string;
  isClose: boolean;
  isSelfClosing: boolean;
};

export const FINAL_TAG_NAME = "final";
const FINAL_TAG_CANDIDATE_RE = /<[^<>]*>/g;

function parseAttributeList(text: string): boolean {
  const attribute = /[^\s=/"'<>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?/y;
  let index = skipWhitespace(text, 0);
  while (index < text.length) {
    attribute.lastIndex = index;
    if (!attribute.test(text)) {
      return false;
    }
    index = skipWhitespace(text, attribute.lastIndex);
  }
  return true;
}

/** Parses a candidate `<final>` tag while rejecting lookalike names and malformed attributes. */
function parseFinalTag(text: string): Omit<FinalTagMatch, "index" | "text"> | null {
  let body = text.slice(1, -1).trimStart();
  let isClose = false;
  if (body.startsWith("/")) {
    isClose = true;
    body = body.slice(1).trimStart();
  }

  if (!body.toLowerCase().startsWith(FINAL_TAG_NAME)) {
    return null;
  }
  const boundary = body[FINAL_TAG_NAME.length] ?? "";
  if (boundary && !/\s/.test(boundary) && boundary !== "/") {
    return null;
  }

  let rest = body.slice(FINAL_TAG_NAME.length);
  if (isClose) {
    return rest.trim().length === 0 ? { isClose: true, isSelfClosing: false } : null;
  }

  const trimmedRest = rest.trimEnd();
  const isSelfClosing = trimmedRest.endsWith("/");
  rest = isSelfClosing ? trimmedRest.slice(0, -1) : rest;
  if (!parseAttributeList(rest)) {
    return null;
  }
  return { isClose: false, isSelfClosing };
}

/** Finds valid `<final>` control tags so callers can strip only actual model markers. */
export function findFinalTagMatches(text: string): FinalTagMatch[] {
  const matches: FinalTagMatch[] = [];
  for (const match of text.matchAll(FINAL_TAG_CANDIDATE_RE)) {
    const tagText = match[0];
    const parsed = parseFinalTag(tagText);
    if (!parsed) {
      continue;
    }
    matches.push({
      index: match.index ?? 0,
      text: tagText,
      ...parsed,
    });
  }
  return matches;
}

/** Removes final-answer markers outside Markdown code while preserving their enclosed answer. */
export function stripFinalTags(
  text: string,
  options?: {
    contentStart: number;
    codeRegions: () => ReturnType<typeof findCodeRegions>;
  },
): string {
  const matches = findFinalTagMatches(text).filter(
    (match) => match.index >= (options?.contentStart ?? 0),
  );
  if (matches.length === 0) {
    return text;
  }
  // Literal examples must survive the final delivery sanitizer, just as they do reasoning cleanup.
  const codeRegions = options?.codeRegions() ?? findCodeRegions(text);
  let codeIndex = 0;
  let output = "";
  let lastIndex = 0;
  for (const match of matches) {
    // Both lists are ordered; advance once rather than rescanning every code region per tag.
    let codeRegion = codeRegions[codeIndex];
    while (codeRegion && codeRegion.end <= match.index) {
      codeIndex += 1;
      codeRegion = codeRegions[codeIndex];
    }
    if (codeRegion && codeRegion.start <= match.index) {
      continue;
    }
    output += text.slice(lastIndex, match.index);
    lastIndex = match.index + match.text.length;
  }
  output += text.slice(lastIndex);
  return output;
}

export const finalTagTextFilter: TextFilter = {
  transform: stripFinalTags,
  create: () =>
    createConditionalTextProjector(
      stripFinalTags,
      createTagNameProbe([FINAL_TAG_NAME]),
      (text, boundary, context) => {
        const pending =
          text.lastIndexOf("<") > text.lastIndexOf(">") ? text.lastIndexOf("<") : Infinity;
        // A completed multiline tag must settle as one token, not at an interior newline.
        const crossesBoundary = findFinalTagMatches(text).some(
          (match) => match.index < boundary && match.index + match.text.length > boundary,
        );
        const safe = boundary > context.contentStart && pending >= boundary && !crossesBoundary;
        return {
          text: stripFinalTags(text, context),
          retainStart: safe ? boundary : context.contentStart,
          retainedOutputStart: safe
            ? stripFinalTags(text.slice(0, boundary), context).length
            : context.contentStart,
        };
      },
    ),
};
