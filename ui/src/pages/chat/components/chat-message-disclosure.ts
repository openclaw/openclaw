export type MessageTextRect = {
  top: number;
  glyphTop: number;
  bottom: number;
  width: number;
  lineHeight: number;
};

const LINE_POSITION_TOLERANCE = 0.5;
const LAST_LINE_VISIBLE_FRACTION = 0.74;
const MIN_LAST_LINE_VISIBLE_FRACTION = 0.66;

export function findMessageDisclosureLine(
  rects: readonly MessageTextRect[],
  lineNumber: number,
): (MessageTextRect & { clamp: number }) | undefined {
  const ordered = rects
    .filter((rect) => rect.width > 0 && rect.bottom > rect.top)
    .toSorted((a, b) => a.top - b.top);
  let line: MessageTextRect | undefined;
  const lines: MessageTextRect[] = [];
  for (const rect of ordered) {
    // Tight line heights can make glyph boxes overlap consecutive text rows.
    if (
      !line ||
      rect.top >= Math.min(line.bottom, line.top + line.lineHeight) - LINE_POSITION_TOLERANCE
    ) {
      if (lines.length > lineNumber) {
        break;
      }
      line = { ...rect };
      lines.push(line);
    } else {
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.glyphTop = Math.min(line.glyphTop, rect.glyphTop);
      line.lineHeight = Math.max(line.lineHeight, rect.lineHeight);
    }
  }
  if (lines.length < lineNumber) {
    return undefined;
  }
  for (let index = lineNumber - 1; index >= 0; index--) {
    const candidate = lines[index]!;
    const next = lines[index + 1];
    // Overhanging glyphs must not leave a sliver of the following line visible.
    const clamp = Math.min(
      candidate.top + candidate.lineHeight * LAST_LINE_VISIBLE_FRACTION,
      next?.glyphTop ?? Infinity,
    );
    if (clamp >= candidate.top + candidate.lineHeight * MIN_LAST_LINE_VISIBLE_FRACTION) {
      return { ...candidate, clamp };
    }
  }
  return undefined;
}
