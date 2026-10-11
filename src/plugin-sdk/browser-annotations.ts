/** Page-side browser annotation contract. The browser host owns delivery and permissions. */
export type BrowserAnnotationTarget = {
  id: string;
  name: string;
  role?: string;
  rect: { x: number; y: number; width: number; height: number };
  /** JSON data supplied by the page, never host authority or executable instructions. */
  metadata?: unknown;
};

export type BrowserAnnotationColorControl = {
  type: "color";
  label?: string;
  callback: string;
  currentValue: string;
};

export type BrowserAnnotationControls = {
  controls: BrowserAnnotationColorControl[];
  controlsHeading?: string;
  controlsMode?: "replace";
};

export type BrowserAnnotationControlChange = {
  action: "preview" | "preview-original" | "reset";
  callback: string;
  value: string;
  virtualTarget: { surfaceId: string; targetId: string };
};

/**
 * Available as document.openclaw.annotation in supported managed browser panels.
 * Browser callers supply Element so these declarations stay usable without DOM globals.
 */
export type BrowserAnnotationApi<ElementType extends EventTarget> = {
  readonly version: 1;
  registerSurface(options: {
    element: ElementType;
    hitTest(point: {
      clientX: number;
      clientY: number;
      signal: AbortSignal;
    }): BrowserAnnotationTarget | null | Promise<BrowserAnnotationTarget | null>;
    renderSelection(selection: { selectedId: string | null; hoveredId: string | null }): void;
  }): { invalidate(): void; dispose(): void };
  registerControls(options: BrowserAnnotationControls & { targets: ElementType }): {
    update(options: Partial<BrowserAnnotationControls>): void;
    dispose(): void;
  };
  /** Acceptance changes annotation mode, not chat delivery. Entry requires user activation. */
  toggle(active: boolean): { accepted: boolean };
  isActive(): boolean;
  request(
    element: ElementType,
    options: { mode?: "default"; enterAnnotationMode?: boolean; metadata?: unknown },
  ): { accepted: boolean };
};

/** Read-only host projection; scoped to one document and its selected virtual target. */
export type BrowserAnnotationState = {
  documentId: string;
  active: boolean;
  surfaceCount: number;
  selection: (BrowserAnnotationTarget & { surfaceId: string }) | null;
  controls: BrowserAnnotationColorControl[];
  controlsHeading: string;
};

/** Narrow browser-host operations; no script evaluation or direct chat send. */
export type BrowserAnnotationCommand =
  | { action: "state" }
  | { action: "stop"; documentId: string }
  | { action: "select"; documentId: string; clientX: number; clientY: number }
  | ({ action: "control"; documentId: string } & Omit<BrowserAnnotationControlChange, "action"> & {
        change: BrowserAnnotationControlChange["action"];
      });
