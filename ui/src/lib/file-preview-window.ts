export interface CodeWindow {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
}

export const FILE_PREVIEW_LINE_HEIGHT = 22;
export const FILE_PREVIEW_OVERSCAN = 30;

export function computeCodeWindow(
  totalLines: number,
  scrollTop: number,
  viewportHeight: number,
  lineHeight = FILE_PREVIEW_LINE_HEIGHT,
  overscan = FILE_PREVIEW_OVERSCAN,
): CodeWindow {
  const total = Math.max(0, Math.floor(totalLines));
  const height = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1);
  const offset = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const firstVisible = Math.min(total, Math.floor(offset / lineHeight));
  const visibleLines = Math.max(1, Math.ceil(height / lineHeight));
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(total, firstVisible + visibleLines + overscan);
  return {
    start,
    end,
    topSpacer: start * lineHeight,
    bottomSpacer: Math.max(0, total - end) * lineHeight,
  };
}
