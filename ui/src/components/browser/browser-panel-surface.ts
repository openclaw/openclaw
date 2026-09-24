import { t } from "../../i18n/index.ts";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import {
  buildBrowserAnnotationContent,
  type BrowserAnnotationDispatchResult,
  composeAnnotatedImage,
  dispatchBrowserAnnotation,
  paintAnnotations,
  type AnnotationRegion,
  type AnnotationStroke,
} from "./browser-annotation.ts";
import type {
  BrowserInspectedNode,
  BrowserPageMetrics,
  BrowserPanelTab,
} from "./browser-client.ts";
import type { BrowserTabTarget } from "./browser-target.ts";

registerBrowserEnglish();

const FORWARDED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** One rendered page snapshot plus the geometry needed to map pointer coords. */
export type BrowserPanelView = {
  kind?: "native" | "remote";
  targetId: string;
  browserTab?: BrowserTabTarget;
  dataUrl: string;
  image: HTMLImageElement;
  url: string;
  metrics: BrowserPageMetrics | null;
};

export function loadBrowserPanelImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () =>
      reject(new Error(t("browser.errors.screenshotDecodeFailed"))),
    );
    image.src = dataUrl;
  });
}

export function browserPanelShouldForwardKey(key: string): boolean {
  return FORWARDED_KEYS.has(key) || key.length === 1;
}

/** Normalized [0..1] stage coordinates for a pointer event, ignoring any letterbox margin. */
export function browserPanelStageNormalizedPoint(
  stage: HTMLElement | null,
  event: MouseEvent,
): { x: number; y: number } | null {
  if (!stage) {
    return null;
  }
  const rect = stage.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

/**
 * Painted frame box inside the stage. The frame image uses `object-fit: contain`,
 * so the visible area letterboxes inside the element box; geometry (pointer
 * mapping, annotation painting) must use the painted area, not the element.
 */
function renderedFrameBox(stage: HTMLElement | null): DOMRect | null {
  const shot =
    stage && typeof stage.querySelector === "function"
      ? stage.querySelector<HTMLImageElement>(".bp-shot")
      : null;
  if (!shot) {
    return null;
  }
  const rect = shot.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const naturalWidth = shot.naturalWidth;
  const naturalHeight = shot.naturalHeight;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return rect;
  }
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return new DOMRect(
    rect.left + (rect.width - width) / 2,
    rect.top + (rect.height - height) / 2,
    width,
    height,
  );
}

/** Normalized [0..1] stage coordinates for a pointer event. */
export function browserPanelNormalizedPoint(
  stage: HTMLElement | null,
  event: MouseEvent,
): { x: number; y: number } | null {
  if (!stage) {
    return null;
  }
  // The live frame may letterbox inside the stage (locked viewport, or a
  // stream frame that still matches an older panel size); pointers must map
  // against the rendered frame box, not the surrounding stage.
  const rect = renderedFrameBox(stage) ?? stage.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  // Clicks in the letterbox margin around a scaled frame are not part of the page.
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x, y };
}

/** Remote CSS-pixel coordinates for a pointer event. */
export function browserPanelRemotePoint(
  stage: HTMLElement | null,
  event: MouseEvent,
  view: BrowserPanelView | null,
): { x: number; y: number } | null {
  const point = browserPanelNormalizedPoint(stage, event);
  if (!point || !view) {
    return null;
  }
  const cssWidth = view.metrics?.cssWidth ?? view.image.naturalWidth;
  const cssHeight = view.metrics?.cssHeight ?? view.image.naturalHeight;
  return { x: point.x * cssWidth, y: point.y * cssHeight };
}

export function browserPanelInspectHighlightRegion(
  view: BrowserPanelView | null,
  node: BrowserInspectedNode | null,
): AnnotationRegion | null {
  if (!view || !node) {
    return null;
  }
  const cssWidth = view.metrics?.cssWidth ?? view.image.naturalWidth;
  const cssHeight = view.metrics?.cssHeight ?? view.image.naturalHeight;
  if (cssWidth <= 0 || cssHeight <= 0) {
    return null;
  }
  return {
    x: node.rect.x / cssWidth,
    y: node.rect.y / cssHeight,
    width: node.rect.width / cssWidth,
    height: node.rect.height / cssHeight,
  };
}

export function paintBrowserPanelOverlay(
  canvas: HTMLCanvasElement | null,
  stage: HTMLElement | null,
  strokes: AnnotationStroke[],
  highlight: AnnotationRegion | null,
): void {
  if (!canvas || !stage) {
    return;
  }
  const width = Math.max(1, Math.round(stage.clientWidth));
  const height = Math.max(1, Math.round(stage.clientHeight));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, width, height);
  // Strokes/highlights are normalized against the painted frame, which may
  // letterbox inside the stage; paint frame-sized content at the frame origin.
  const stageRect = stage.getBoundingClientRect();
  const frameBox = renderedFrameBox(stage);
  const frameWidth = Math.max(1, Math.round(frameBox?.width ?? width));
  const frameHeight = Math.max(1, Math.round(frameBox?.height ?? height));
  const offsetX = frameBox ? Math.round(frameBox.left - stageRect.left) : 0;
  const offsetY = frameBox ? Math.round(frameBox.top - stageRect.top) : 0;
  context.save();
  context.translate(offsetX, offsetY);
  paintAnnotations(context, { width: frameWidth, height: frameHeight, strokes, highlight });
  context.restore();
}

export function dispatchCompositedBrowserAnnotation(
  view: BrowserPanelView,
  tab: BrowserPanelTab | undefined,
  strokes: AnnotationStroke[],
  element: BrowserInspectedNode | null,
  highlight: AnnotationRegion | null,
): BrowserAnnotationDispatchResult {
  const url = view.metrics?.url || view.url || tab?.url || "";
  const title = view.metrics?.title || tab?.title || "";
  const content = buildBrowserAnnotationContent({
    url,
    title,
    strokes,
    element,
    browserTab: view.kind === "native" ? undefined : view.browserTab,
  });
  const dataUrl = composeAnnotatedImage({
    image: view.image,
    width: view.image.naturalWidth,
    height: view.image.naturalHeight,
    strokes,
    highlight,
  });
  return dispatchBrowserAnnotation({ ...content, dataUrl, fileName: "annotated-page.png" });
}
