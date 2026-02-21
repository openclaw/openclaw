import MarkdownIt from "markdown-it";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarkdownSegment =
  | { kind: "text"; markdown: string }
  | { kind: "table"; markdown: string; index: number };

// ---------------------------------------------------------------------------
// Parser (shared instance, tables always enabled)
// ---------------------------------------------------------------------------

const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });
md.enable("table");

// ---------------------------------------------------------------------------
// Quick heuristic — avoids a full parse when there's obviously no table.
// Matches both piped (`| A | B |`) and pipeless (`A | B`) GFM table rows,
// combined with a separator line (e.g. `---|---` or `|:---|---:|`).
// ---------------------------------------------------------------------------

const PIPE_LINE_RE = /^[|].*[|]|^[^|]+[|]/m;
const SEPARATOR_RE = /^\|?\s*[-:]+[-| :]*\|?\s*$/m;

function mightContainTable(markdown: string): boolean {
  return PIPE_LINE_RE.test(markdown) && SEPARATOR_RE.test(markdown);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split markdown into ordered text / table segments.
 *
 * Tables inside fenced code blocks are never detected (markdown-it
 * lexes them as `fence` tokens, not `table_open`).
 */
export function splitMarkdownTables(markdown: string): MarkdownSegment[] {
  if (!markdown) {
    return [];
  }
  if (!mightContainTable(markdown)) {
    return [{ kind: "text", markdown }];
  }

  const tokens = md.parse(markdown, {});
  const lines = markdown.split("\n");

  // Collect [startLine, endLine) ranges for every top-level table.
  const tableRanges: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    if (token.type === "table_open" && token.map) {
      tableRanges.push({ start: token.map[0], end: token.map[1] });
    }
  }

  if (tableRanges.length === 0) {
    return [{ kind: "text", markdown }];
  }

  const segments: MarkdownSegment[] = [];
  let currentLine = 0;
  let tableIndex = 0;

  for (const range of tableRanges) {
    // Text before this table
    if (currentLine < range.start) {
      const text = lines.slice(currentLine, range.start).join("\n");
      if (text.trim()) {
        segments.push({ kind: "text", markdown: text });
      }
    }

    // The table itself
    const tableMarkdown = lines.slice(range.start, range.end).join("\n");
    segments.push({ kind: "table", markdown: tableMarkdown, index: tableIndex++ });
    currentLine = range.end;
  }

  // Trailing text after the last table
  if (currentLine < lines.length) {
    const text = lines.slice(currentLine).join("\n");
    if (text.trim()) {
      segments.push({ kind: "text", markdown: text });
    }
  }

  return segments;
}
