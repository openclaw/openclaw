import type { MarkdownTableMode } from "../config/types.base.js";
import type { FenceSpan } from "./fences.js";
import { isSafeFenceBreak } from "./fences.js";
import { markdownToIRWithMeta } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";

export type TableSpan = {
  start: number;
  end: number;
};

const MARKDOWN_STYLE_MARKERS = {
  bold: { open: "**", close: "**" },
  italic: { open: "_", close: "_" },
  strikethrough: { open: "~~", close: "~~" },
  code: { open: "`", close: "`" },
  code_block: { open: "```\n", close: "```" },
} as const;

export function convertMarkdownTables(
  markdown: string,
  mode: MarkdownTableMode,
): string {
  if (!markdown || mode === "off") {
    return markdown;
  }
  const effectiveMode = mode === "block" ? "code" : mode;
  const { ir, hasTables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: effectiveMode,
  });
  if (!hasTables) {
    return markdown;
  }
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: MARKDOWN_STYLE_MARKERS,
    escapeText: (text) => text,
    buildLink: (link, text) => {
      const href = link.href.trim();
      if (!href) {
        return null;
      }
      const label = text.slice(link.start, link.end);
      if (!label) {
        return null;
      }
      return {
        start: link.start,
        end: link.end,
        open: "[",
        close: `](${href})`,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Table span detection — identifies contiguous markdown table regions so that
// chunkers can avoid splitting inside them (same idea as fence spans).
//
// A markdown table is:
//   1. A header row containing at least one `|`
//   2. A separator row matching /^\|?[\s:]*-{3,}[\s:|-]*$/
//   3. Zero or more data rows containing `|`
//
// Tables inside code fences are ignored (they are already protected by fence
// span logic).
// ---------------------------------------------------------------------------

const TABLE_SEPARATOR_RE = /^\|?[\s:]*-{3,}[\s:|-]*$/;

/**
 * Parse markdown table regions, returning sorted non-overlapping spans.
 * Each span covers from the start of the header row to the end of the last
 * contiguous data row. Tables inside code fences are excluded.
 */
export function parseTableSpans(
  buffer: string,
  fenceSpans?: FenceSpan[],
): TableSpan[] {
  const spans: TableSpan[] = [];
  const lines = splitLines(buffer);

  for (let i = 0; i < lines.length - 1; i++) {
    const headerLine = lines[i];
    const separatorLine = lines[i + 1];

    // Header must contain a pipe character.
    if (!headerLine.text.includes("|")) {
      continue;
    }

    // Separator must match the table separator pattern.
    if (!TABLE_SEPARATOR_RE.test(separatorLine.text)) {
      continue;
    }

    // Skip tables inside code fences.
    if (fenceSpans && !isSafeFenceBreak(fenceSpans, headerLine.start)) {
      continue;
    }

    // Found a table start. Walk forward to find all contiguous data rows.
    let tableEnd = separatorLine.start + separatorLine.text.length;
    let j = i + 2;
    while (j < lines.length) {
      const row = lines[j];
      if (!row.text.includes("|")) {
        break;
      }
      tableEnd = row.start + row.text.length;
      j++;
    }

    spans.push({ start: headerLine.start, end: tableEnd });

    // Skip past the table for the outer loop.
    i = j - 1;
  }

  return spans;
}

/**
 * Returns true when `index` is NOT inside any table span — i.e. it is safe to
 * break/split at this position without cutting through a table.
 */
export function isSafeTableBreak(spans: TableSpan[], index: number): boolean {
  // Binary search — spans are sorted and non-overlapping.
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (index <= span.start) {
      high = mid - 1;
    } else if (index >= span.end) {
      low = mid + 1;
    } else {
      return false;
    }
  }
  return true;
}

/** Split buffer into lines with their start offsets. */
function splitLines(buffer: string): { text: string; start: number }[] {
  const result: { text: string; start: number }[] = [];
  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    result.push({ text: buffer.slice(offset, lineEnd), start: offset });
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }
  return result;
}
