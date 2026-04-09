import type { FenceSpan } from "./fences.js";

/**
 * Parse contiguous markdown table blocks in a buffer.
 *
 * A table block is:
 *   - A header row containing `|`
 *   - A separator row matching `| --- | --- |` pattern
 *   - Zero or more data rows containing `|`
 *
 * Tables are treated as atomic spans. When a table exceeds the chunk limit,
 * the header + separator are repeated in the continuation chunk.
 */

export type TableSpan = {
  /** Byte offset of the first character of the header row. */
  start: number;
  /** Byte offset of the last character (exclusive) of the last data row. */
  end: number;
  /** The full header row text (without trailing newline). */
  headerLine: string;
  /** The full separator row text (without trailing newline). */
  separatorLine: string;
};

const SEPARATOR_RE = /^\|?[\s-:|]+\|[\s-:|]*$/;

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("|") || !line.includes("-")) {
    return false;
  }
  return SEPARATOR_RE.test(line.trim());
}

export function parseTableSpans(buffer: string, fenceSpans?: FenceSpan[]): TableSpan[] {
  const spans: TableSpan[] = [];
  const lines: { text: string; start: number; end: number }[] = [];

  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    lines.push({ text: buffer.slice(offset, lineEnd), start: offset, end: lineEnd });
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }

  const isInsideFence = (start: number): boolean =>
    fenceSpans?.some((f) => start >= f.start && start < f.end) ?? false;

  let i = 0;
  while (i < lines.length - 1) {
    const headerLine = lines[i];
    const sepLine = lines[i + 1];

    if (
      !isTableRow(headerLine.text) ||
      !isSeparatorRow(sepLine.text) ||
      isInsideFence(headerLine.start)
    ) {
      i++;
      continue;
    }

    // Found header + separator. Consume data rows.
    let lastEnd = sepLine.end;
    let j = i + 2;
    while (j < lines.length && isTableRow(lines[j].text)) {
      lastEnd = lines[j].end;
      j++;
    }

    spans.push({
      start: headerLine.start,
      end: lastEnd,
      headerLine: headerLine.text,
      separatorLine: sepLine.text,
    });

    i = j;
  }

  return spans;
}

export function findTableSpanAt(spans: TableSpan[], index: number): TableSpan | undefined {
  return spans.find((span) => index > span.start && index < span.end);
}

export function isSafeTableBreak(spans: TableSpan[], index: number): boolean {
  return !findTableSpanAt(spans, index);
}
