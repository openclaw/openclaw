export type FenceSpan = {
  start: number;
  end: number;
  openLine: string;
  marker: string;
  indent: string;
};

export function parseFenceSpans(buffer: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let open:
    | {
        start: number;
        markerChar: string;
        markerLen: number;
        openLine: string;
        marker: string;
        indent: string;
      }
    | undefined;

  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    const line = buffer.slice(offset, lineEnd);

    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (match) {
      const indent = match[1];
      const marker = match[2];
      const markerChar = marker[0];
      const markerLen = marker.length;
      if (!open) {
        open = {
          start: offset,
          markerChar,
          markerLen,
          openLine: line,
          marker,
          indent,
        };
      } else if (open.markerChar === markerChar && markerLen >= open.markerLen) {
        const end = lineEnd;
        spans.push({
          start: open.start,
          end,
          openLine: open.openLine,
          marker: open.marker,
          indent: open.indent,
        });
        open = undefined;
      }
    }

    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }

  if (open) {
    spans.push({
      start: open.start,
      end: buffer.length,
      openLine: open.openLine,
      marker: open.marker,
      indent: open.indent,
    });
  }

  return spans;
}

export function findFenceSpanAt(spans: FenceSpan[], index: number): FenceSpan | undefined {
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

export function isSafeFenceBreak(spans: FenceSpan[], index: number): boolean {
  return !findFenceSpanAt(spans, index);
}
