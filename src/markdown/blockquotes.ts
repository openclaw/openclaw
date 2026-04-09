/**
 * Detect blockquote regions (lines starting with `>`) and provide helpers
 * for re-applying the blockquote prefix when a chunk split lands inside one.
 */

export type BlockquoteSpan = {
  /** Byte offset of the first `>` character. */
  start: number;
  /** Byte offset past the last character of the blockquote block. */
  end: number;
  /** The prefix string, e.g. `"> "` or `">> "`. */
  prefix: string;
};

const BQ_RE = /^(>+\s?)/;

export function parseBlockquoteSpans(buffer: string): BlockquoteSpan[] {
  const spans: BlockquoteSpan[] = [];
  let offset = 0;
  let current: { start: number; prefix: string } | undefined;

  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    const line = buffer.slice(offset, lineEnd);

    const match = line.match(BQ_RE);
    if (match) {
      const prefix = match[1];
      if (!current) {
        current = { start: offset, prefix };
      } else {
        // Update prefix to latest (handles varying depth, keeps the most recent)
        current.prefix = prefix;
      }
    } else {
      if (current) {
        spans.push({
          start: current.start,
          end: offset > 0 ? offset - 1 : offset,
          prefix: current.prefix,
        });
        current = undefined;
      }
    }

    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }

  if (current) {
    spans.push({ start: current.start, end: buffer.length, prefix: current.prefix });
  }

  return spans;
}

export function findBlockquoteAt(
  spans: BlockquoteSpan[],
  index: number,
): BlockquoteSpan | undefined {
  return spans.find((span) => index > span.start && index < span.end);
}

/**
 * Given raw continuation text that was split from inside a blockquote,
 * re-apply the `> ` prefix to every line.
 */
export function reapplyBlockquotePrefix(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") {
        return line;
      }
      // Don't double-prefix lines that already have it
      if (line.startsWith(prefix.trimEnd())) {
        return line;
      }
      return `${prefix}${line}`;
    })
    .join("\n");
}
