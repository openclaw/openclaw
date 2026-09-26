// Shared XML tag boundaries for visible-text cleanup and artifact-only recognition.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { skipWhitespace } from "../../../packages/tool-call-repair/src/grammar.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";

export function createQuotedStringScanner(text: string, start: number): (end: number) => boolean {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;
  // Candidate closing tags share one monotonic scan through their payload.
  let cursor = start;
  return (end) => {
    for (; cursor < end; cursor += 1) {
      const char = text[cursor];
      if (quoteChar === null) {
        if (char === '"' || char === "'") {
          quoteChar = char;
        }
      } else if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === quoteChar) {
        quoteChar = null;
      }
    }
    return quoteChar !== null;
  };
}

export interface ParsedToolCallTag {
  contentStart: number;
  end: number;
  isClose: boolean;
  isSelfClosing: boolean;
  tagName: string;
  isTruncated: boolean;
}

// Match only the tag head; quote-aware scanning owns the close boundary.
const XML_TAG_HEAD_RE = /<\s*(?:(\/)\s*)?([A-Za-z_:][A-Za-z0-9_.:-]*)(?=$|[\s/>])/y;

export function parseXmlTagAt(text: string, start: number): ParsedToolCallTag | null {
  XML_TAG_HEAD_RE.lastIndex = start;
  const match = XML_TAG_HEAD_RE.exec(text);
  if (!match) {
    return null;
  }
  const contentStart = XML_TAG_HEAD_RE.lastIndex;
  const isClose = match[1] === "/";
  const closeIndex = findTagCloseIndex(text, contentStart);
  const isTruncated = closeIndex === -1;
  return {
    contentStart,
    end: isTruncated ? text.length : closeIndex + 1,
    isClose,
    isSelfClosing: !isTruncated && !isClose && /\/\s*$/.test(text.slice(contentStart, closeIndex)),
    tagName: normalizeLowercaseStringOrEmpty(match[2]),
    isTruncated,
  };
}

function findTagCloseIndex(text: string, start: number): number {
  const isInsideQuote = createQuotedStringScanner(text, start);
  for (let idx = start; idx < text.length; idx += 1) {
    const char = text[idx];
    if ((char === "<" || char === ">") && !isInsideQuote(idx)) {
      return char === ">" ? idx : -1;
    }
  }
  return -1;
}

/** Recognize complete artifact-only XML without treating literal Markdown as control text. */
export function isToolCallXmlArtifact(text: string): boolean {
  const start = skipWhitespace(text, 0);
  const first = parseXmlTagAt(text, start);
  if (!first || first.isClose || first.isSelfClosing || first.isTruncated) {
    return false;
  }
  const firstKind = first.tagName.replace(/^antml:/, "");
  const wrapped = firstKind === "function_calls";
  if (!wrapped && firstKind !== "invoke") {
    return false;
  }
  const codeRegions = findCodeRegions(text);
  if (isInsideCode(start, codeRegions)) {
    return false;
  }
  const parents = [first.tagName];
  let cursor = first.end;
  while (cursor < text.length) {
    const parent = parents.at(-1);
    const parentKind = parent?.replace(/^antml:/, "");
    const inParameter = parentKind === "parameter";
    const offset = inParameter ? text.indexOf("<", cursor) : skipWhitespace(text, cursor);
    if (offset === -1) {
      return false;
    }
    if (offset === text.length) {
      break;
    }
    if (inParameter) {
      // Argument text may contain literal less-than signs or non-control markup.
      // Inspect only the tag head so malformed literals never rescan the suffix.
      XML_TAG_HEAD_RE.lastIndex = offset;
      const head = XML_TAG_HEAD_RE.exec(text);
      const headKind = normalizeLowercaseStringOrEmpty(head?.[2]).replace(/^antml:/, "");
      if (headKind !== "parameter" && headKind !== "invoke" && headKind !== "function_calls") {
        cursor = offset + 1;
        continue;
      }
    }
    const tag = parseXmlTagAt(text, offset);
    if (!tag || tag.isTruncated) {
      return false;
    }
    if (tag.isClose && text.slice(tag.contentStart, tag.end - 1).trim() !== "") {
      return false;
    }
    const kind = tag.tagName.replace(/^antml:/, "");
    if (inParameter) {
      if (tag.isClose && tag.tagName === parent) {
        parents.pop();
      } else if (kind === "invoke" || kind === "function_calls" || kind === "parameter") {
        // A malformed argument must not consume a later invocation and intervening prose.
        return false;
      }
    } else {
      if (tag.isSelfClosing || isInsideCode(offset, codeRegions)) {
        return false;
      }
      if (tag.isClose) {
        if (tag.tagName !== parent) {
          return false;
        }
        parents.pop();
      } else {
        if ((!parent && wrapped) || kind !== (parentKind === "invoke" ? "parameter" : "invoke")) {
          return false;
        }
        parents.push(tag.tagName);
      }
    }
    // Every parsed tag advances once; argument text cannot backtrack across sibling blocks.
    cursor = tag.end;
  }
  return parents.length === 0;
}
