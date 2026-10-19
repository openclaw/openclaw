import type { AnnotationStroke } from "./browser-annotation.ts";
import type { BrowserInspectedNode, BrowserPanelTab } from "./browser-client.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";

export type BrowserPanelMode = "interact" | "annotate" | "inspect";
export type BrowserPanelState = {
  running: boolean | null;
  canAutoResizeViewport: boolean;
  tabs: BrowserPanelTab[];
  /** Stable tab handle (plugin alias when available), not a raw CDP target id. */
  activeTargetId: string | null;
  view: BrowserPanelView | null;
  loading: boolean;
  errorText: string | null;
  noticeText: string | null;
  mode: BrowserPanelMode;
  strokes: AnnotationStroke[];
  inspected: BrowserInspectedNode | null;
  inspectPointer: { x: number; y: number } | null;
  evaluateUnavailable: boolean;
  urlDraft: string;
  pendingNewTab: boolean;
  urlDraftEditing: boolean;
  addressInput: HTMLInputElement | undefined;
};

export type BrowserPanelStateWriter<Keys extends keyof BrowserPanelState> = Pick<
  BrowserPanelState,
  Keys
> & {
  setState<Key extends Keys>(key: Key, value: BrowserPanelState[Key]): void;
};
