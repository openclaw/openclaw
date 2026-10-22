/** Payload delivered to the active chat pane when an annotation is sent. */
export type BrowserAnnotationDraft = {
  modelContext: string;
  card: {
    title: string;
    displayUrl: string;
    markedRegionCount: number;
    inspectedElement: boolean;
  };
  /** PNG data URL of the screenshot with the markup composited in. */
  dataUrl: string;
  fileName: string;
};

export type BrowserAnnotationDispatchResult = "accepted" | "rejected" | "unhandled";
export type BrowserAnnotationEvent = CustomEvent<BrowserAnnotationDraft> & {
  /** Synchronous consumer rejection keeps capture state retryable in the browser panel. */
  rejection?: "limit";
};

export const BROWSER_ANNOTATION_EVENT = "openclaw:browser-annotation";
