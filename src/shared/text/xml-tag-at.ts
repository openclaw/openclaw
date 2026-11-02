// Quote-aware XML tag head scan used by assistant-visible tool-call stripping.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export interface ParsedToolCallTag {
  contentStart: number;
  end: number;
  isClose: boolean;
  isSelfClosing: boolean;
  tagName: string;
  isTruncated: boolean;
}

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
