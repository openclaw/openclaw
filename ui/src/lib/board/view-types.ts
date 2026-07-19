import type { BoardOp, BoardSnapshot, BoardTab, BoardWidget } from "@openclaw/gateway-protocol";

export type { BoardOp, BoardSnapshot, BoardTab, BoardWidget };
export type BoardGrantDecision = "granted" | "rejected";

/** Native Control UI card, derived from session state rather than the board store. */
export type BoardBuiltinWidget = Omit<BoardWidget, "contentKind"> & {
  builtin: "swarm";
  contentKind: "builtin";
  readOnly: true;
};
export type BoardViewWidget = BoardWidget | BoardBuiltinWidget;
export type BoardViewSnapshot = Omit<BoardSnapshot, "widgets"> & {
  widgets: BoardViewWidget[];
};

export type BoardViewCallbacks = {
  applyOps: (ops: BoardOp[]) => Promise<void>;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  selectTab: (tabId: string) => void;
  frameLoadFailed?: (name: string) => Promise<void>;
};

export type BoardWidgetFrameUrl = (name: string, revision: number) => string;
