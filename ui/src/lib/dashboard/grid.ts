// Grid math + hand-rolled pointer drag/drop + resize for the Workspaces view.
//
// Pure functions only — no DOM, no gateway. The view wires pointer events to
// `beginDrag`/`updateDrag` and reads back a snapped ghost rect; on drop it asks
// `resolveDrop` for the final placement (rejecting overlaps, offering the nearest
// free slot per spec-30). Keeping the geometry here makes it unit-testable and
// keeps the view a thin renderer (workboard three-way split).

import { DASHBOARD_GRID_COLUMNS, type DashboardGridRect, type DashboardWidget } from "./types.ts";

/** Fixed row height + gutter, in CSS pixels (spec-30 §Grid). */
export const DASHBOARD_ROW_HEIGHT = 56;
export const DASHBOARD_GRID_GAP = 12;

export type DashboardDragMode = "move" | "resize";

export type DashboardDragState = {
  widgetId: string;
  mode: DashboardDragMode;
  /** Grid rect at the moment the drag started. */
  originRect: DashboardGridRect;
  /** Pointer client coords at drag start. */
  originClientX: number;
  originClientY: number;
  /** Live snapped rect, updated as the pointer moves. */
  ghostRect: DashboardGridRect;
  /** Width of one grid column in pixels, captured from the grid element. */
  columnWidth: number;
};

export type DashboardGridMetrics = {
  /** Pixel width of the grid content box. */
  width: number;
};

/** Column width in pixels given the grid content width. Gaps sit between cells. */
export function columnWidth(metrics: DashboardGridMetrics): number {
  const totalGap = DASHBOARD_GRID_GAP * (DASHBOARD_GRID_COLUMNS - 1);
  return Math.max(1, (metrics.width - totalGap) / DASHBOARD_GRID_COLUMNS);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Snap a fractional column delta to whole grid units. */
export function snapCells(deltaPx: number, unitPx: number): number {
  if (unitPx <= 0) {
    return 0;
  }
  return Math.round(deltaPx / (unitPx + DASHBOARD_GRID_GAP));
}

/** Clamp a rect so it stays inside the 12-column grid; height/y are unbounded below. */
export function clampRect(rect: DashboardGridRect): DashboardGridRect {
  const w = clamp(rect.w, 1, DASHBOARD_GRID_COLUMNS);
  const h = Math.max(1, rect.h);
  const x = clamp(rect.x, 0, DASHBOARD_GRID_COLUMNS - w);
  const y = Math.max(0, rect.y);
  return { x, y, w, h };
}

export function rectsEqual(a: DashboardGridRect, b: DashboardGridRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Do two grid rects share any cell? Touching edges do NOT overlap. */
export function rectsOverlap(a: DashboardGridRect, b: DashboardGridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Rects of every widget except the one identified by `exceptId`. */
function otherRects(widgets: readonly DashboardWidget[], exceptId: string): DashboardGridRect[] {
  return widgets.filter((widget) => widget.id !== exceptId).map((widget) => widget.grid);
}

/** Does `rect` overlap any widget other than `exceptId`? */
export function collides(
  rect: DashboardGridRect,
  widgets: readonly DashboardWidget[],
  exceptId: string,
): boolean {
  return otherRects(widgets, exceptId).some((other) => rectsOverlap(rect, other));
}

/** Begin a drag/resize gesture from a pointer-down on a widget's chrome. */
export function beginDrag(params: {
  widget: DashboardWidget;
  mode: DashboardDragMode;
  clientX: number;
  clientY: number;
  metrics: DashboardGridMetrics;
}): DashboardDragState {
  return {
    widgetId: params.widget.id,
    mode: params.mode,
    originRect: { ...params.widget.grid },
    originClientX: params.clientX,
    originClientY: params.clientY,
    ghostRect: { ...params.widget.grid },
    columnWidth: columnWidth(params.metrics),
  };
}

/** Advance a drag with the current pointer position; returns the snapped ghost rect. */
export function updateDrag(
  drag: DashboardDragState,
  clientX: number,
  clientY: number,
): DashboardGridRect {
  const rowUnit = DASHBOARD_ROW_HEIGHT;
  const deltaCols = snapCells(clientX - drag.originClientX, drag.columnWidth);
  const deltaRows = snapCells(clientY - drag.originClientY, rowUnit);
  const next =
    drag.mode === "move"
      ? {
          x: drag.originRect.x + deltaCols,
          y: drag.originRect.y + deltaRows,
          w: drag.originRect.w,
          h: drag.originRect.h,
        }
      : {
          x: drag.originRect.x,
          y: drag.originRect.y,
          w: drag.originRect.w + deltaCols,
          h: drag.originRect.h + deltaRows,
        };
  const clamped = clampRect(next);
  drag.ghostRect = clamped;
  return clamped;
}

/**
 * Resolve where a dropped widget lands. Overlapping drops are rejected (spec-30:
 * "reject drops that overlap, offer nearest free slot"); the nearest collision-free
 * slot to the requested position is returned instead. Returns null only if the
 * grid genuinely has no free slot for the widget's size (defensive; the grid is
 * unbounded downward so this is unreachable in practice).
 */
export function resolveDrop(params: {
  requested: DashboardGridRect;
  widgets: readonly DashboardWidget[];
  widgetId: string;
}): DashboardGridRect | null {
  const requested = clampRect(params.requested);
  if (!collides(requested, params.widgets, params.widgetId)) {
    return requested;
  }
  return nearestFreeSlot(requested, params.widgets, params.widgetId);
}

/**
 * Search outward from the requested position (increasing Manhattan-ish rings) for
 * the closest slot that fits `requested`'s size without colliding. The grid grows
 * downward, so a fit is always found within a bounded number of rows.
 */
export function nearestFreeSlot(
  requested: DashboardGridRect,
  widgets: readonly DashboardWidget[],
  widgetId: string,
): DashboardGridRect | null {
  const w = clamp(requested.w, 1, DASHBOARD_GRID_COLUMNS);
  const h = Math.max(1, requested.h);
  const maxX = DASHBOARD_GRID_COLUMNS - w;
  const occupiedRows = otherRects(widgets, widgetId).reduce(
    (max, rect) => Math.max(max, rect.y + rect.h),
    0,
  );
  // One extra band below everything guarantees a free row exists.
  const maxY = Math.max(requested.y, occupiedRows) + h;
  let best: { rect: DashboardGridRect; distance: number } | null = null;
  for (let y = 0; y <= maxY; y += 1) {
    for (let x = 0; x <= maxX; x += 1) {
      const candidate: DashboardGridRect = { x, y, w, h };
      if (collides(candidate, widgets, widgetId)) {
        continue;
      }
      const distance = Math.abs(x - requested.x) + Math.abs(y - requested.y);
      if (!best || distance < best.distance) {
        best = { rect: candidate, distance };
      }
    }
    // Once a fit is found on a row, no lower row can be closer.
    if (best && y >= requested.y) {
      break;
    }
  }
  return best?.rect ?? null;
}

/** CSS grid-column/grid-row shorthand for a rect (1-based grid lines). */
export function gridPlacementStyle(rect: DashboardGridRect): string {
  return [
    `grid-column: ${rect.x + 1} / span ${rect.w}`,
    `grid-row: ${rect.y + 1} / span ${rect.h}`,
  ].join("; ");
}

/** Total rows a set of widgets spans (for sizing the grid's min-height). */
export function gridRowCount(widgets: readonly DashboardWidget[]): number {
  return widgets.reduce((max, widget) => Math.max(max, widget.grid.y + widget.grid.h), 0);
}

export const KEYBOARD_MOVE_STEP = 1;

/** Nudge a rect by keyboard for the a11y move/resize fallback (spec-30). */
export function nudgeRect(
  rect: DashboardGridRect,
  mode: DashboardDragMode,
  direction: "left" | "right" | "up" | "down",
): DashboardGridRect {
  const step = KEYBOARD_MOVE_STEP;
  if (mode === "move") {
    const dx = direction === "left" ? -step : direction === "right" ? step : 0;
    const dy = direction === "up" ? -step : direction === "down" ? step : 0;
    return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
  }
  const dw = direction === "left" ? -step : direction === "right" ? step : 0;
  const dh = direction === "up" ? -step : direction === "down" ? step : 0;
  return clampRect({ ...rect, w: rect.w + dw, h: rect.h + dh });
}
