export type TableSpan = {
  start: number;
  end: number;
};

type MarkdownLine = {
  start: number;
  end: number;
  text: string;
};

function collectMarkdownLines(buffer: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    lines.push({
      start: offset,
      end: lineEnd,
      text: buffer.slice(offset, lineEnd),
    });
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }
  return lines;
}

function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split("|").map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const cells = splitTableCells(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isMarkdownTableDelimiter(line: string): boolean {
  const cells = splitTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

export function parseTableSpans(buffer: string): TableSpan[] {
  const lines = collectMarkdownLines(buffer);
  const spans: TableSpan[] = [];

  for (let i = 0; i < lines.length - 1; i += 1) {
    const header = lines[i];
    const delimiter = lines[i + 1];
    if (!header || !delimiter) {
      continue;
    }
    if (!isMarkdownTableRow(header.text) || !isMarkdownTableDelimiter(delimiter.text)) {
      continue;
    }

    let end = delimiter.end;
    let cursor = i + 2;
    while (cursor < lines.length) {
      const row = lines[cursor];
      if (!row || !isMarkdownTableRow(row.text)) {
        break;
      }
      end = row.end;
      cursor += 1;
    }

    spans.push({ start: header.start, end });
    i = Math.max(i, cursor - 1);
  }

  return spans;
}

export function findTableSpanAt(spans: TableSpan[], index: number): TableSpan | undefined {
  let low = 0;
  let high = spans.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (!span) {
      break;
    }
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

export function isSafeTableBreak(spans: TableSpan[], index: number): boolean {
  return !findTableSpanAt(spans, index);
}
