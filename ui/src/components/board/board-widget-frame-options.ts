import type { ApplicationContext } from "../../app/context.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import type { FrameRefresh } from "./board-widget-ticket-refresh.ts";

export type BoardWidgetFrameHost = {
  active: () => boolean;
  loadingCovered?: () => boolean;
  bridgeEnabled?: () => boolean;
  connected: () => boolean;
  context: () => ApplicationContext | undefined;
  refreshFrame: () => FrameRefresh | undefined;
  reportContentHeight: (name: string, height: number) => void;
  scrollBy: (deltaY: number) => void;
  resolveFrameUrl: () => BoardWidgetFrameUrl | undefined;
  widget: () => BoardWidget | undefined;
  lobbyPresentation?: () => { collapsed: boolean } | undefined;
};
