import { BOARD_GRID_GAP, BOARD_GRID_ROW_HEIGHT } from "./grid.ts";
import type { BoardViewWidget } from "./view-types.ts";

// Keep this numeric inset aligned with the app-level --widget-frame-inset token.
const BOARD_WIDGET_FRAME_INSET = 12;
const BOARD_WIDGET_AUTO_MIN_ROWS = 2;
const BOARD_WIDGET_AUTO_MAX_ROWS = 20;
// Mirrors the 38px header grid row in board.css: coarse-pointer layouts keep
// the bar in flow, so auto height must reserve it or content clips by one bar.
const BOARD_WIDGET_TOUCH_BAR_PX = 38;

export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export function boardChromeRowPx(): number {
  // jsdom lacks matchMedia; missing capability data defaults to the overlay
  // (fine-pointer) layout where the bar reserves no row space.
  return typeof window.matchMedia === "function" && !window.matchMedia(FINE_POINTER_QUERY).matches
    ? BOARD_WIDGET_TOUCH_BAR_PX
    : 0;
}

export function effectiveBoardWidgetRows(
  widget: BoardViewWidget,
  contentHeightPx: number | undefined,
  chromeRowPx = 0,
): number {
  if (
    widget.contentKind !== "html" ||
    widget.heightMode === "fixed" ||
    contentHeightPx === undefined ||
    !Number.isFinite(contentHeightPx) ||
    contentHeightPx <= 0
  ) {
    return widget.sizeH;
  }
  const requiredHeight =
    contentHeightPx +
    chromeRowPx +
    ((widget.presentation ?? "card") === "card" ? BOARD_WIDGET_FRAME_INSET * 2 : 0);
  const rows = Math.ceil(
    (requiredHeight + BOARD_GRID_GAP) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP),
  );
  return Math.min(BOARD_WIDGET_AUTO_MAX_ROWS, Math.max(BOARD_WIDGET_AUTO_MIN_ROWS, rows));
}
