import type { ChatSplitEdge } from "./split-layout-types.ts";

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
  const horizontal = zone.edge === "left" || zone.edge === "right";
  const size = horizontal ? "width" : "height";
  const position = horizontal ? "left" : "top";
  fullRect[size] /= 2;
  if (zone.edge === "right" || zone.edge === "down") {
    fullRect[position] += fullRect[size];
  }
  return fullRect;
}
