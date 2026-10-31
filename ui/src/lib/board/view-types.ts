import type { BoardOp } from "@openclaw/gateway-protocol";
import type { BoardWidget } from "./types.ts";
import type { PreparedBoardSandbox } from "./widget-sandbox-prewarm.ts";

export type BoardGrantDecision = "granted" | "rejected";
export type BoardWidgetAppViewState =
  | { status: "ready"; viewId: string; expiresAtMs: number }
  | { status: "stale" };

export type BoardViewCallbacks = {
  heightLayout?: {
    cached: boolean;
    read: (key: string) => number | undefined;
    write: (key: string, height: number) => void;
  };
  takePreparedSandbox?: (widget: BoardWidget, url: string) => PreparedBoardSandbox | undefined;
  appViewGeneration?: number;
  applyOps: (ops: BoardOp[]) => Promise<void>;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  selectTab: (tabId: string) => void;
  frameLoadFailed?: (name: string) => Promise<void>;
  widgetAppView?: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView?: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

export type BoardWidgetFrameUrl = (name: string, revision: number) => string;
