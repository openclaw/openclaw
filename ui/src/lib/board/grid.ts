export const BOARD_GRID_COLUMNS = 12;
export const BOARD_GRID_ROW_HEIGHT = 56;
export const BOARD_GRID_GAP = 12;
export const BOARD_DOCUMENT_AUTO_MAX_ROWS = 240;
const BOARD_GRID_MAX_HEIGHT = 20;

export type BoardGridItem = {
  name: string;
  w: number;
  h: number;
  order: number;
};

export type BoardGridRect = {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type BoardGridCell = {
  x: number;
  y: number;
};

export type BoardGridDirection = "left" | "right" | "up" | "down";

function clampInteger(value: number, minimum: number, maximum: number): number {
  const integer = Number.isFinite(value) ? Math.round(value) : minimum;
  return Math.min(maximum, Math.max(minimum, integer));
}

function withOrder(item: BoardGridItem, order: number): BoardGridItem {
  return { name: item.name, w: item.w, h: item.h, order };
}

function canonicalItems(
  items: readonly BoardGridItem[],
  maxItemHeight = BOARD_GRID_MAX_HEIGHT,
): BoardGridItem[] {
  return items
    .map((item) => ({
      name: item.name,
      w: clampInteger(item.w, 1, BOARD_GRID_COLUMNS),
      h: clampInteger(item.h, 1, maxItemHeight),
      order: Number.isFinite(item.order) ? item.order : 0,
    }))
    .toSorted((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map(withOrder);
}

function fits(occupied: readonly number[], x: number, y: number, w: number, h: number): boolean {
  // The fixed 12-column grid fits in one occupancy mask per row.
  const columns = ((1 << w) - 1) << x;
  for (let row = y; row < y + h; row += 1) {
    if ((occupied[row] ?? 0) & columns) {
      return false;
    }
  }
  return true;
}

function placeFirstFit(occupied: number[], item: BoardGridItem): BoardGridRect {
  for (let y = 0; ; y += 1) {
    for (let x = 0; x <= BOARD_GRID_COLUMNS - item.w; x += 1) {
      if (fits(occupied, x, y, item.w, item.h)) {
        const columns = ((1 << item.w) - 1) << x;
        for (let row = y; row < y + item.h; row += 1) {
          occupied[row] = (occupied[row] ?? 0) | columns;
        }
        return { name: item.name, x, y, w: item.w, h: item.h };
      }
    }
  }
}

/**
 * Places canonical-order items at the first available row-major cell. Earlier
 * items therefore keep priority while every later item is gravity-tight.
 */
export function layout(
  items: readonly BoardGridItem[],
  maxItemHeight = BOARD_GRID_MAX_HEIGHT,
): BoardGridRect[] {
  return layoutCanonicalItems(canonicalItems(items, maxItemHeight));
}

function layoutCanonicalItems(items: readonly BoardGridItem[]): BoardGridRect[] {
  const occupied: number[] = [];
  return items.map((item) => placeFirstFit(occupied, item));
}

function contains(rect: BoardGridRect, cell: BoardGridCell): boolean {
  return (
    cell.x >= rect.x && cell.x < rect.x + rect.w && cell.y >= rect.y && cell.y < rect.y + rect.h
  );
}

/**
 * Reorders against a named current rectangle or the fallback grid cell.
 * Resolve targets before removing the moving item so responsive card stacking
 * and successive previews keep the same logical target through pointerup.
 */
export function previewDrag(
  items: readonly BoardGridItem[],
  name: string,
  target: BoardGridCell & { name: string | undefined },
): BoardGridItem[] {
  const canonical = canonicalItems(items);
  const movingIndex = canonical.findIndex((item) => item.name === name);
  if (movingIndex < 0) {
    return canonical;
  }

  const currentRects = layoutCanonicalItems(canonical);
  const targetCell = currentRects.find((rect) => rect.name === target.name) ?? target;
  const cell = {
    x: clampInteger(targetCell.x, 0, BOARD_GRID_COLUMNS - 1),
    y: Math.max(0, Number.isFinite(targetCell.y) ? Math.floor(targetCell.y) : 0),
  };
  const currentRect = currentRects.find((rect) => rect.name === name);
  if (currentRect && contains(currentRect, cell)) {
    return canonical;
  }

  const moving = canonical.splice(movingIndex, 1);
  const occupiedTarget = currentRects.find((rect) => rect.name !== name && contains(rect, cell));
  const nextRect =
    occupiedTarget ??
    currentRects
      .filter(
        (rect) =>
          rect.name !== name && (rect.y > cell.y || (rect.y === cell.y && rect.x >= cell.x)),
      )
      .toSorted((left, right) => left.y - right.y || left.x - right.x)[0];
  const insertionIndex = nextRect
    ? canonical.findIndex((item) => item.name === nextRect.name)
    : canonical.length;
  canonical.splice(Math.max(0, insertionIndex), 0, ...moving);
  return canonical.map(withOrder);
}

export function resize(
  items: readonly BoardGridItem[],
  name: string,
  w: number,
  h: number,
): BoardGridItem[] {
  return canonicalItems(items).map((item) =>
    item.name === name
      ? {
          name: item.name,
          w: clampInteger(w, 1, BOARD_GRID_COLUMNS),
          h: clampInteger(h, 1, BOARD_GRID_MAX_HEIGHT),
          order: item.order,
        }
      : item,
  );
}

/** Arrow-key fallback: left/up move earlier; right/down move later. */
export function nudge(
  items: readonly BoardGridItem[],
  name: string,
  direction: BoardGridDirection,
): BoardGridItem[] {
  const canonical = canonicalItems(items);
  const index = canonical.findIndex((item) => item.name === name);
  if (index < 0) {
    return canonical;
  }
  const delta = direction === "left" || direction === "up" ? -1 : 1;
  const target = Math.min(canonical.length - 1, Math.max(0, index + delta));
  if (target !== index) {
    canonical.splice(target, 0, ...canonical.splice(index, 1));
  }
  return canonical.map(withOrder);
}

// Keep this numeric inset aligned with the app-level --widget-frame-inset token.
const BOARD_WIDGET_FRAME_INSET = 12;
// board.css keeps a 1px border even when frameless. Reserve both edges so
// viewport-sized content does not lose 2px on every resize report.
const BOARD_WIDGET_BORDER_PX = 1;
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

function autoBoardWidgetHeightPx(
  widget: BoardWidgetSizingInput,
  contentHeightPx: number | undefined,
  chromeRowPx: number,
): number | undefined {
  // Absent heightMode means auto BY DESIGN, including widgets pinned before
  // the contract existed: retroactive content-fitting is the product goal, and
  // one menu click re-pins. Only an explicit "fixed" preserves stored height.
  if (
    widget.contentKind !== "html" ||
    widget.heightMode === "fixed" ||
    contentHeightPx === undefined ||
    !Number.isFinite(contentHeightPx) ||
    contentHeightPx <= 0
  ) {
    return undefined;
  }
  return (
    contentHeightPx +
    BOARD_WIDGET_BORDER_PX * 2 +
    chromeRowPx +
    ((widget.presentation ?? "card") === "card" ? BOARD_WIDGET_FRAME_INSET * 2 : 0)
  );
}

function boardRowSpanPx(rows: number): number {
  return rows * BOARD_GRID_ROW_HEIGHT + (rows - 1) * BOARD_GRID_GAP;
}

export function effectiveBoardWidgetRows(
  widget: BoardWidgetSizingInput,
  contentHeightPx: number | undefined,
  chromeRowPx = 0,
  maxAutoRows = BOARD_WIDGET_AUTO_MAX_ROWS,
): number {
  const requiredHeight = autoBoardWidgetHeightPx(widget, contentHeightPx, chromeRowPx);
  if (requiredHeight === undefined) {
    return widget.sizeH;
  }
  const rows = Math.ceil(
    (requiredHeight + BOARD_GRID_GAP) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP),
  );
  const minimumRows = Math.max(BOARD_WIDGET_AUTO_MIN_ROWS, rows);
  return Math.min(maxAutoRows, minimumRows);
}

/**
 * Exact card height for auto-sized HTML widgets. The grid cell stays quantized
 * to rows (`effectiveBoardWidgetRows`), but the card hugs its content so the
 * ceil-to-row slack lands outside the card as background spacing instead of
 * dead space inside it. Undefined means "fill the cell" (fixed/non-HTML).
 */
export function exactBoardWidgetHeightPx(
  widget: BoardWidgetSizingInput,
  contentHeightPx: number | undefined,
  chromeRowPx = 0,
  maxAutoRows = BOARD_WIDGET_AUTO_MAX_ROWS,
): number | undefined {
  const requiredHeight = autoBoardWidgetHeightPx(widget, contentHeightPx, chromeRowPx);
  if (requiredHeight === undefined) {
    return undefined;
  }
  // Never exceed the quantized cell. The normal editable board retains its row
  // cap; shell-free documents can raise it so the document owns vertical scroll.
  return Math.min(
    requiredHeight,
    boardRowSpanPx(effectiveBoardWidgetRows(widget, contentHeightPx, chromeRowPx, maxAutoRows)),
  );
}

/** Structural sizing inputs so pure grid math stays free of view-type imports. */
type BoardWidgetSizingInput = {
  contentKind: string;
  heightMode?: "auto" | "fixed";
  presentation?: "card" | "full-bleed" | "frameless";
  sizeH: number;
};

export function boardWidgetGridItems(
  widgets: readonly (BoardWidgetSizingInput & { name: string; sizeW: number; position: number })[],
  contentHeights: ReadonlyMap<string, number>,
  fitAutoContent = false,
  pageWidgetName = "",
): BoardGridItem[] {
  const chromeRowPx = boardChromeRowPx();
  return widgets.map((widget) => ({
    name: widget.name,
    w: widget.sizeW,
    h: effectiveBoardWidgetRows(
      widget,
      contentHeights.get(widget.name),
      widget.name === pageWidgetName ? 0 : chromeRowPx,
      fitAutoContent ? BOARD_DOCUMENT_AUTO_MAX_ROWS : undefined,
    ),
    order: widget.position,
  }));
}
