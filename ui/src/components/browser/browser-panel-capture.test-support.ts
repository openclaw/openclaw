import { afterEach, beforeEach, vi } from "vitest";
import { BROWSER_ANNOTATION_EVENT } from "./browser-annotation.ts";

export function setupAnnotationCapture() {
  const receive = vi.fn<(event: Event) => void>();
  beforeEach(() => {
    receive.mockReset();
    window.addEventListener(BROWSER_ANNOTATION_EVENT, receive);
  });
  afterEach(() => window.removeEventListener(BROWSER_ANNOTATION_EVENT, receive));
  return { receive, stubCanvas };
}

type PaintMethod = "beginPath" | "moveTo" | "lineTo" | "stroke" | "strokeRect";
function stubCanvas(methods: readonly PaintMethod[]) {
  const canvas = HTMLCanvasElement.prototype;
  const drawImage = vi.fn();
  vi.spyOn(canvas, "getContext").mockReturnValue({
    drawImage,
    ...Object.fromEntries(methods.map((name) => [name, vi.fn()])),
  } as unknown as CanvasRenderingContext2D);
  const toDataURL = vi.spyOn(canvas, "toDataURL");
  toDataURL.mockReturnValue("data:image/png;base64,annotated");
  return { drawImage, toDataURL };
}
