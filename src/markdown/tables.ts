import type { MarkdownTableMode } from "../config/types.base.js";
import type { FenceSpan } from "./fences.js";
import { markdownToIRWithMeta } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";

const MARKDOWN_STYLE_MARKERS = {
  bold: { open: "**", close: "**" },
  italic: { open: "_", close: "_" },
  strikethrough: { open: "~~", close: "~~" },
  code: { open: "`", close: "`" },
  code_block: { open: "```\n", close: "```" },
} as const;

export function convertMarkdownTables(markdown: string, mode: MarkdownTableMode): string {
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
      return { start: link.start, end: link.end, open: "[", close: `](${href})` };
    },
  });
}

// ---------------------------------------------------------------------------
// Table span detection – mirrors the FenceSpan / isSafeFenceBreak pattern so
// callers can protect markdown tables from being split mid-table.
// ---------------------------------------------------------------------------

export type TableSpan = {
  /** Byte offset of the first character of the header row. */
  start: number;
  /** Byte offset of the last character of the last data row (exclusive). */
  end: number;
};

/**
 * A separator row must contain at least one `|` so that plain thematic breaks
 * (`---`) are not mistaken for table separators.
 */
const TABLE_SEPARATOR_RE = /^\|[\s:]*-{3,}[\s:|-]*$|^[\s:]*-{3,}[\s:|-]*\|[\s:|-]*$/;

function splitLines(text: string): { line: string; start: number; end: number }[] {
  const result: { line: string; start: number; end: number }[] = [];
  let offset = 0;
  while (offset <= text.length) {
    const nl = text.indexOf("\n", offset);
    const lineEnd = nl === -1 ? text.length : nl;
    result.push({ line: text.slice(offset, lineEnd), start: offset, end: lineEnd });
    if (nl === -1) break;
    offset = nl + 1;
  }
  return result;
}

/**
 * Detect contiguous markdown table regions in `text`, skipping any tables that
 * overlap with fenced code blocks described by `fenceSpans`.
 */
export function parseTableSpans(text: string, fenceSpans: FenceSpan[]): TableSpan[] {
  const lines = splitLines(text);
  const spans: TableSpan[] = [];
  let i = 0;
  while (i < lines.length - 1) {
    const headerLine = lines[i];
    const separatorLine = lines[i + 1];
    // Header must contain `|` and the next line must be a valid separator.
    if (
      headerLine.line.includes("|") &&
      TABLE_SEPARATOR_RE.test(separatorLine.line.trim())
    ) {
      // Skip tables that start inside a fenced code block.
      if (fenceSpans.some((f) => headerLine.start >= f.start && headerLine.start < f.end)) {
        i += 1;
        continue;
      }
      const tableStart = headerLine.start;
      // Consume data rows (any line containing `|`).
      let lastEnd = separatorLine.end;
      let j = i + 2;
      while (j < lines.length && lines[j].line.includes("|")) {
        lastEnd = lines[j].end;
        j += 1;
      }
      spans.push({ start: tableStart, end: lastEnd });
      i = j;
      continue;
    }
    i += 1;
  }
  return spans;
}

function findTableSpanAt(spans: TableSpan[], index: number): TableSpan | undefined {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (!span) break;
    if (index <= span.start) {
      high = mid - 1;
      continue;
    }
    if (index >= span.end) {
      low = mid + 1;
      continue;
    }
    return span;
  }
  return undefined;
}

/** Returns `true` when `index` does NOT fall inside a table span. */
export function isSafeTableBreak(spans: TableSpan[], index: number): boolean {
  return !findTableSpanAt(spans, index);
}
