import type { ChatSplitEdge, ChatSplitLayout } from "./split-layout-types.ts";
import { findPane, insertPane } from "./split-layout.ts";

export type SplitDropZone = { kind: "edge"; edge: ChatSplitEdge } | { kind: "center" };
export type SplitDropRect = { left: number; top: number; width: number; height: number };

const EDGE_BAND = 0.3;

export function resolveSplitDropZone(rect: SplitDropRect, x: number, y: number): SplitDropZone {
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;
  const horizontal =
    nx <= EDGE_BAND
      ? { edge: "left" as const, distance: nx }
      : 1 - nx <= EDGE_BAND
        ? { edge: "right" as const, distance: 1 - nx }
        : null;
  const vertical =
    ny <= EDGE_BAND
      ? { edge: "up" as const, distance: ny }
      : 1 - ny <= EDGE_BAND
        ? { edge: "down" as const, distance: 1 - ny }
        : null;
  const nearest =
    horizontal && vertical
      ? horizontal.distance <= vertical.distance
        ? horizontal
        : vertical
      : (horizontal ?? vertical);
  return nearest ? { kind: "edge", edge: nearest.edge } : { kind: "center" };
}

export function splitDropIndicatorRect(rect: SplitDropRect, zone: SplitDropZone): SplitDropRect {
  const fullRect = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  if (zone.kind === "center") {
    return fullRect;
  }
  if (zone.edge === "left") {
    return { ...fullRect, width: rect.width / 2 };
  }
  if (zone.edge === "right") {
    return { ...fullRect, left: rect.left + rect.width / 2, width: rect.width / 2 };
  }
  if (zone.edge === "up") {
    return { ...fullRect, height: rect.height / 2 };
  }
  return { ...fullRect, top: rect.top + rect.height / 2, height: rect.height / 2 };
}

/**
 * Where the incoming pane will actually land once `insertPane` redistributes weights —
 * an even share of the whole row/column when sizing is automatic, or half of just the
 * target's slot when the layout has been manually resized. Mirrors the real insertion
 * math instead of assuming a plain half-pane split.
 */
export function splitDropInsertionRect(
  layout: ChatSplitLayout,
  containerRect: SplitDropRect,
  targetPaneId: string,
  edge: ChatSplitEdge,
): SplitDropRect {
  const predicted = insertPane(layout, targetPaneId, "__split-drop-preview__", edge);
  const location = findPane(predicted, predicted.activePaneId);
  if (!location) {
    return containerRect;
  }
  const columnOffset = predicted.columnWeights
    .slice(0, location.columnIndex)
    .reduce((sum, weight) => sum + weight, 0);
  const columnWeight = predicted.columnWeights[location.columnIndex] ?? 0;
  const paneOffset = location.column.paneWeights
    .slice(0, location.paneIndex)
    .reduce((sum, weight) => sum + weight, 0);
  const paneWeight = location.column.paneWeights[location.paneIndex] ?? 0;
  return {
    left: containerRect.left + containerRect.width * columnOffset,
    top: containerRect.top + containerRect.height * paneOffset,
    width: containerRect.width * columnWeight,
    height: containerRect.height * paneWeight,
  };
}
