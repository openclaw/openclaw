import type {
  BoardOp,
  BoardSnapshot as GatewayBoardSnapshot,
  BoardTab,
  BoardWidget as GatewayBoardWidget,
} from "@openclaw/gateway-protocol";

export type { BoardOp, BoardTab };
export type BoardGrantDecision = "granted" | "rejected";

/** Native Control UI card, derived from session state rather than the board store. */
export type BoardBuiltinWidget = Omit<GatewayBoardWidget, "contentKind"> & {
  builtin: "swarm";
  contentKind: "builtin";
  readOnly: true;
};
export type BoardWidget = GatewayBoardWidget | BoardBuiltinWidget;
export type BoardSnapshot = Omit<GatewayBoardSnapshot, "widgets"> & {
  widgets: BoardWidget[];
};

export type BoardViewCallbacks = {
  applyOps: (ops: BoardOp[]) => Promise<void>;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  selectTab: (tabId: string) => void;
  frameLoadFailed?: (name: string) => Promise<void>;
};

export type BoardWidgetFrameUrl = (name: string, revision: number) => string;
