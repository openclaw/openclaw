// Pure geometry for the composer resize grips: storage parsing and drag
// clamping. DOM application lives in chat-composer-resize.ts; this module
// stays dependency-free so the node suite can cover it without a browser.
export const COMPOSER_HEIGHT_STORAGE_KEY = "***";

export const COMPOSER_HEIGHT_MIN_PX = 96;
export const COMPOSER_COLUMN_MIN_PX = 480;
// A width drag only owns the setting after intentional movement: smaller
// pointer jitter (clicks, out-and-back returns) must leave a stored
// responsive value (e.g. "82%") untouched instead of rewriting it as px.
export const COMPOSER_WIDTH_DRAG_COMMIT_THRESHOLD_PX = 3;
// Clamp ratios stay private: the suite covers them through the clamp
// functions, so every export keeps a production importer (Knip).
const COMPOSER_HEIGHT_MAX_VIEWPORT_RATIO = 0.8;
const COMPOSER_COLUMN_VIEWPORT_MARGIN_PX = 24;

export function parseStoredPixels(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function clampComposerHeightPx(px: number, viewportHeight: number): number {
  const max = Math.max(
    COMPOSER_HEIGHT_MIN_PX,
    Math.floor(viewportHeight * COMPOSER_HEIGHT_MAX_VIEWPORT_RATIO),
  );
  return Math.min(Math.max(Math.round(px), COMPOSER_HEIGHT_MIN_PX), max);
}

export function clampComposerColumnMaxPx(px: number, viewportWidth: number): number {
  const max = Math.max(COMPOSER_COLUMN_MIN_PX, viewportWidth - COMPOSER_COLUMN_VIEWPORT_MARGIN_PX);
  return Math.min(Math.max(Math.round(px), COMPOSER_COLUMN_MIN_PX), max);
}

export function shouldCommitWidthDrag(
  cancelled: boolean,
  maxAbsDxPx: number,
  finalAbsDxPx: number,
): boolean {
  // No commit for cancelled gestures, sub-threshold jitter, or drags that
  // returned to (near) their origin: none of those resized anything, so
  // the stored preference survives untouched.
  return (
    !cancelled &&
    maxAbsDxPx >= COMPOSER_WIDTH_DRAG_COMMIT_THRESHOLD_PX &&
    finalAbsDxPx >= COMPOSER_WIDTH_DRAG_COMMIT_THRESHOLD_PX
  );
}
