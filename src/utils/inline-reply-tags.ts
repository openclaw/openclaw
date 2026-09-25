export type InlineReplyTag = {
  start: number;
  end: number;
  id?: string;
  complete: boolean;
};

const REPLY_HEAD = /\[\[\s*(reply_to_current|reply_to\s*:)/iy;

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && isWhitespace(text.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let cursor = start;
  while (text.charAt(cursor) === " " || text.charAt(cursor) === "\t") {
    cursor += 1;
  }
  return cursor;
}

/** Reads increasing marker offsets without rescanning nested candidates' shared suffixes. */
export function createInlineReplyTagReader(
  text: string,
): (start: number, allowLeadingMalformed?: boolean) => InlineReplyTag | null {
  let close = -1;
  let contentEnd = -1;
  let lineFeed = -1;
  const leadingStart = skipHorizontalWhitespace(text, 0);

  const closingBracket = (from: number) => {
    if (close < from) {
      const found = text.indexOf("]", from);
      close = found < 0 ? text.length : found;
      contentEnd = close;
      while (contentEnd > 0 && isWhitespace(text.charAt(contentEnd - 1))) {
        contentEnd -= 1;
      }
    }
    return close;
  };

  const firstLineFeed = (from: number) => {
    if (lineFeed < from) {
      const found = text.indexOf("\n", from);
      lineFeed = found < 0 ? text.length : found;
    }
    return lineFeed;
  };

  return (start, allowLeadingMalformed = false) => {
    REPLY_HEAD.lastIndex = start;
    const head = REPLY_HEAD.exec(text);
    if (!head) {
      return null;
    }
    const headEnd = REPLY_HEAD.lastIndex;
    const explicit = head[1]?.endsWith(":") === true;
    const valueStart = skipWhitespace(text, headEnd);

    if (!explicit) {
      if (text.startsWith("]]", valueStart)) {
        return { start, end: valueStart + 2, complete: true };
      }
    } else {
      const end = closingBracket(valueStart);
      if (text.startsWith("]]", end)) {
        if (valueStart < end && firstLineFeed(valueStart) >= contentEnd) {
          return { start, end: end + 2, id: text.slice(valueStart, contentEnd), complete: true };
        }
        // The historical grammar requires one ID character. Blank IDs can use
        // any whitespace except LF, even though sanitization later removes it.
        if (valueStart === end) {
          for (let cursor = headEnd; cursor < end; cursor += 1) {
            if (text.charAt(cursor) !== "\n") {
              return { start, end: end + 2, id: "", complete: true };
            }
          }
        }
      }
    }

    if (!allowLeadingMalformed || start !== leadingStart) {
      return null;
    }
    if (explicit) {
      if (valueStart === text.length) {
        return { start, end: text.length, complete: false };
      }
      const end = closingBracket(valueStart);
      if (end === text.length || text.charAt(end + 1) === "]") {
        return null;
      }
      // Malformed leading IDs historically disallow CR as well as LF. This
      // recovery is examined only at the one absolute leading marker.
      for (let cursor = valueStart; cursor < end; cursor += 1) {
        if (text.charAt(cursor) === "\r" || text.charAt(cursor) === "\n") {
          return null;
        }
      }
      return { start, end: skipHorizontalWhitespace(text, end + 1), complete: false };
    }

    const end = skipHorizontalWhitespace(text, headEnd);
    if (text.charAt(end) === "]" && text.charAt(end + 1) !== "]") {
      return { start, end: skipHorizontalWhitespace(text, end + 1), complete: false };
    }
    if (end === text.length || (end > headEnd && !isWhitespace(text.charAt(end)))) {
      return { start, end, complete: false };
    }
    return null;
  };
}
