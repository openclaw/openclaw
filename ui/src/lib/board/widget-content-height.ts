import { buildWidgetThemeMessage } from "../widget-theme.ts";
import { boardChromeRowPx } from "./grid.ts";
import type { BoardWidget } from "./types.ts";
import { hashWidgetIdentity } from "./widget-names.ts";

export function boardWidgetHeightKey(widget: BoardWidget, width: number, page: boolean): string {
  return hashWidgetIdentity(
    JSON.stringify([
      widget.name,
      widget.instanceId,
      widget.viewGeneration,
      widget.revision,
      width,
      boardChromeRowPx(),
      page,
      buildWidgetThemeMessage(),
    ]),
  );
}
