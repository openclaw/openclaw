import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type { BoardGridDirection, BoardGridRect } from "../../lib/board/grid.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/provider.ts";
import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";
import type { BoardGrantDecision, BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import type { SolidBridgeElement } from "../../lit/solid-bridge.ts";

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

export type BoardWidgetCellCallbacks = {
  appViewGeneration: () => number;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  movePointerDown: (widget: BoardWidget, event: PointerEvent) => void;
  resizePointerDown: (widget: BoardWidget, event: PointerEvent) => void;
  moveToTab: (widget: BoardWidget, tabId: string) => Promise<void>;
  resizeTo: (widget: BoardWidget, w: number, h: number) => Promise<void>;
  setHeightMode: (widget: BoardWidget, mode: "auto" | "fixed") => Promise<void>;
  reportContentHeight: (name: string, height: number) => void;
  remove: (widget: BoardWidget) => Promise<void>;
  nudge: (widget: BoardWidget, direction: BoardGridDirection) => Promise<void>;
  focus: (widget: BoardWidget, direction: BoardGridDirection) => void;
  focusChanged: (name: string) => void;
  frameLoadFailed: (name: string) => Promise<void>;
  widgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

export type BoardWidgetCellProps = {
  widget?: BoardWidget;
  rect?: BoardGridRect;
  contentHeightPx?: number;
  fitAutoContent?: boolean;
  pageChrome?: boolean;
  tabs?: readonly BoardTab[];
  session?: BoardGetParams;
  sessionKey?: string;
  widgetFrameUrl?: BoardWidgetFrameUrl;
  callbacks?: BoardWidgetCellCallbacks;
  active?: boolean;
  bridgeEnabled?: boolean;
  dragging?: boolean;
  focusTabIndex?: number;
  positionInSet?: number;
  setSize?: number;
  busy?: boolean;
  canMutate?: boolean;
  canGrant?: boolean;
  loadingCovered?: boolean;
};
export type BoardWidgetCellHandle = {
  readonly presentationReady: boolean;
  selectMenuItem(value: string | undefined): void;
  teardown(): Promise<void>;
  restartAfterTeardown(): void;
};

export type BoardWidgetCellMethods = Omit<BoardWidgetCellHandle, "presentationReady">;
type BoardWidgetCellElement = SolidBridgeElement<BoardWidgetCellProps, BoardWidgetCellMethods> &
  Pick<BoardWidgetCellHandle, "presentationReady">;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-widget-cell": BoardWidgetCellElement;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-board-widget-cell": HTMLAttributes<BoardWidgetCellElement> &
        Properties<BoardWidgetCellElement>;
    }
  }
}
