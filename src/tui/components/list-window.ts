/**
 * Start of the visible window for a scrolling list. The first render centers the selection;
 * after that the window moves only when the selection leaves it, so arrowing repaints one row
 * pair instead of every visible row (a screen reader announces each repainted row).
 */
export function stableWindowStart(
  previous: number | undefined,
  selected: number,
  total: number,
  size: number,
): number {
  let start = previous ?? Math.max(0, selected - Math.floor(size / 2));
  if (selected < start) {
    start = selected;
  } else if (selected >= start + size) {
    start = selected - size + 1;
  }
  return Math.min(start, Math.max(0, total - size));
}
