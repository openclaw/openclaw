import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";
import {
  resolveSplitDropZone,
  splitDropIndicatorRect,
  splitDropInsertionRect,
  type SplitDropRect,
  type SplitDropZone,
} from "./split-drop-zone.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";

export type DropIndicator = { paneId: string; zone: SplitDropZone; rect: SplitDropRect };

export function resolveDropIndicator(
  host: ParentNode,
  layout: ChatSplitLayout,
  pane: ChatPaneElement,
  x: number,
  y: number,
): DropIndicator | null {
  const paneId = pane.paneId;
  const container = host.querySelector<HTMLElement>(".chat-split-view__drop-container");
  if (!paneId || !container) {
    return null;
  }
  const paneRect = pane.getBoundingClientRect();
  const zone = resolveSplitDropZone(paneRect, x, y);
  const containerRect = container.getBoundingClientRect();
  // Center drops replace the pane in place; edge drops actually redistribute the
  // row/column, so the preview must be computed the same way insertPane resizes it.
  const indicatorRect =
    zone.kind === "center"
      ? splitDropIndicatorRect(paneRect, zone)
      : splitDropInsertionRect(
          layout,
          {
            left: containerRect.left,
            top: containerRect.top,
            width: containerRect.width,
            height: containerRect.height,
          },
          paneId,
          zone.edge,
        );
  return {
    paneId,
    zone,
    rect: {
      left: indicatorRect.left - containerRect.left,
      top: indicatorRect.top - containerRect.top,
      width: indicatorRect.width,
      height: indicatorRect.height,
    },
  };
}
