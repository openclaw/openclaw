import { expectDefined } from "@openclaw/normalization-core";

export type RedactionEdit = { start: number; end: number; replacement: string };
type RedactionPiece = { start: number; end: number; replacement?: string };

/** Compose sorted, disjoint current-value edits while retaining original source spans. */
export function composeRedactionEdits(
  length: number,
  previous: RedactionEdit[],
  edits: RedactionEdit[],
): RedactionEdit[] {
  if (previous.length === 0) {
    return edits;
  }
  const pieces: RedactionPiece[] = [];
  let source = 0;
  for (const edit of previous) {
    if (source < edit.start) {
      pieces.push({ start: source, end: edit.start });
    }
    pieces.push(edit);
    source = edit.end;
  }
  if (source < length) {
    pieces.push({ start: source, end: length });
  }

  const output: RedactionPiece[] = [];
  let index = 0;
  let offset = 0;
  let position = 0;
  const consume = (end: number, keep: boolean): { start: number; end: number } => {
    if (end === position) {
      const piece = pieces[index];
      if (!piece) {
        return { start: length, end: length };
      }
      const start = piece.replacement === undefined ? piece.start + offset : piece.start;
      return {
        start,
        end: piece.replacement !== undefined && offset > 0 ? piece.end : start,
      };
    }
    let sourceStart: number | undefined;
    let sourceEnd = 0;
    while (position < end) {
      const piece = expectDefined(pieces[index], "current redaction piece");
      const size = piece.replacement?.length ?? piece.end - piece.start;
      const count = Math.min(size - offset, end - position);
      const start = piece.replacement === undefined ? piece.start + offset : piece.start;
      const finish = piece.replacement === undefined ? start + count : piece.end;
      sourceStart ??= start;
      sourceEnd = finish;
      if (keep && count > 0) {
        output.push({
          start,
          end: finish,
          replacement: piece.replacement?.slice(offset, offset + count),
        });
      }
      position += count;
      offset += count;
      if (offset === size) {
        index += 1;
        offset = 0;
      }
    }
    return { start: sourceStart ?? sourceEnd, end: sourceEnd };
  };
  for (const edit of edits) {
    consume(edit.start, true);
    output.push({ ...consume(edit.end, false), replacement: edit.replacement });
  }
  while (index < pieces.length) {
    const piece = expectDefined(pieces[index], "remaining redaction piece");
    consume(position + (piece.replacement?.length ?? piece.end - piece.start) - offset, true);
  }

  const composed: RedactionEdit[] = [];
  let fragments: string[] = [];
  let pending: RedactionEdit | undefined;
  const flush = () => {
    if (pending) {
      pending.replacement = fragments.join("");
      composed.push(pending);
      pending = undefined;
      fragments = [];
    }
  };
  for (const piece of output) {
    if (piece.replacement === undefined) {
      flush();
      continue;
    }
    // Splitting an earlier replacement retains its full source span on each fragment.
    const sameEmptySpan =
      pending &&
      pending.start === piece.start &&
      pending.end === piece.end &&
      piece.start === piece.end;
    if (!pending || (piece.start >= pending.end && !sameEmptySpan)) {
      flush();
      pending = { start: piece.start, end: piece.end, replacement: "" };
    } else {
      pending.end = Math.max(pending.end, piece.end);
    }
    fragments.push(piece.replacement);
  }
  flush();
  return composed;
}

/** Project source-span replacements onto a value that already contains replacements. */
export function rebaseRedactionEdits(
  previous: RedactionEdit[],
  edits: RedactionEdit[],
): RedactionEdit[] {
  let shift = 0;
  const spans = previous.map((edit) => {
    const start = edit.start + shift;
    shift += edit.replacement.length - (edit.end - edit.start);
    return { ...edit, currentStart: start, currentEnd: edit.end + shift };
  });
  const boundary = (position: number, end: boolean): number => {
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const span = expectDefined(spans[middle], "source redaction span");
      if (span.end < position || (span.end === position && span.start !== span.end)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const span = spans[low];
    if (span && (position > span.start || (position === span.start && span.start === span.end))) {
      return end ? span.currentEnd : span.currentStart;
    }
    const before = spans[low - 1];
    return position + (before ? before.currentEnd - before.end : 0);
  };
  return edits.map((edit) => ({
    start: boundary(edit.start, false),
    end: boundary(edit.end, true),
    replacement: edit.replacement,
  }));
}

export function mergeRedactionEdits(edits: RedactionEdit[]): RedactionEdit[] {
  edits.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RedactionEdit[] = [];
  for (const edit of edits) {
    const previous = merged.at(-1);
    if (!previous || edit.start >= previous.end) {
      merged.push({ ...edit });
    } else if (
      edit.start !== previous.start ||
      edit.end !== previous.end ||
      edit.replacement !== previous.replacement
    ) {
      previous.end = Math.max(previous.end, edit.end);
      // Conflicting captures cannot retain a hint exposing another captured value.
      previous.replacement = "***";
    }
  }
  return merged;
}

export function applyRedactionEdits(value: string, edits: RedactionEdit[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of mergeRedactionEdits(edits)) {
    parts.push(value.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  return parts.join("") + value.slice(cursor);
}
