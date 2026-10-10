import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";

export const BOARD_SIZE_PRESETS = {
  sm: { w: 3, h: 3 },
  md: { w: 6, h: 4 },
  lg: { w: 8, h: 6 },
  xl: { w: 12, h: 8 },
} as const;

export function closeBoardWidgetMenu(root: ParentNode): void {
  const menu = root.querySelector<HTMLElement & { open: boolean }>(".board-widget__menu");
  if (menu) {
    menu.open = false;
  }
}

export type BoardWidgetPageMenu = {
  widget: BoardWidget;
  tabs: readonly BoardTab[];
  canMutate: boolean;
  onSelect: (value: string) => void;
};
