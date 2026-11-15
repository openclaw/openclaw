import type { BoardWidget } from "./types.ts";

export function createBoardWidget(overrides: Partial<BoardWidget> = {}): BoardWidget {
  return {
    name: "alpha",
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
    ...overrides,
  };
}
