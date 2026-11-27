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
  errorRetry: (() => Promise<unknown>) | null;
  noticeText: string | null;
  mode: BrowserPanelMode;
  strokes: AnnotationStroke[];
  inspected: BrowserInspectedNode | null;
  inspectPointer: { x: number; y: number } | null;
  evaluateUnavailable: boolean;
  /** This panel's connection holds operator control; other browser input is paused. */
  controlling: boolean;
  /** The Gateway confirmed this route reaches a browser the panel can take control of. */
  controlAvailable: boolean;
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

export function createBrowserPanelState(): BrowserPanelState {
  return {
    running: null,
    canAutoResizeViewport: false,
    tabs: [],
    activeTargetId: null,
    view: null,
    loading: false,
    errorText: null,
    errorRetry: null,
    noticeText: null,
    mode: "interact",
    strokes: [],
    inspected: null,
    inspectPointer: null,
    evaluateUnavailable: false,
    controlling: false,
    controlAvailable: false,
    urlDraft: "",
    pendingNewTab: false,
    urlDraftEditing: false,
    addressInput: undefined,
  };
}
