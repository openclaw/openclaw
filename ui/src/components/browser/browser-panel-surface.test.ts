import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_ANNOTATION_EVENT, type BrowserAnnotationDraft } from "./browser-annotation.ts";
import { createView } from "./browser-panel-controller-test-support.ts";
import {
  dispatchCompositedBrowserAnnotation,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";

describe("dispatchCompositedBrowserAnnotation", () => {
  const drawImage = vi.fn();
  const canvas = HTMLCanvasElement.prototype;
  const strokes = [{ points: [{ x: 0.25, y: 0.5 }] }];
  const capture = (view: BrowserPanelView) =>
    dispatchCompositedBrowserAnnotation(view, undefined, strokes, null, null);
  const view = (kind?: BrowserPanelView["kind"]): BrowserPanelView => ({
    ...createView("tab-1", "https://user:secret@example.com/path"),
    kind,
    browserTab: { target: "host", profile: "managed", targetId: "tab-1" },
    metrics: null,
  });
  beforeEach(() => {
    drawImage.mockClear();
    vi.spyOn(canvas, "getContext").mockReturnValue({
      drawImage,
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/png;base64,annotated");
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["remote", "native"] as const)("retries %s annotation drafts", (kind) => {
    const page = view(kind);
    expect(capture(page)).toBe("unhandled");
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(canvas.toDataURL).toHaveBeenCalledTimes(1);

    let draft: BrowserAnnotationDraft | undefined;
    const consume = (event: Event) => {
      draft = (event as CustomEvent<BrowserAnnotationDraft>).detail;
      event.preventDefault();
    };
    window.addEventListener(BROWSER_ANNOTATION_EVENT, consume);
    try {
      expect(capture(page)).toBe("accepted");
    } finally {
      window.removeEventListener(BROWSER_ANNOTATION_EVENT, consume);
    }

    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(canvas.toDataURL).toHaveBeenCalledTimes(2);
    expect(draft).toMatchObject({
      modelContext: expect.stringContaining("https://example.com/path"),
      card: {
        title: "example.com",
        displayUrl: "example.com",
        markedRegionCount: 1,
        inspectedElement: false,
      },
      dataUrl: "data:image/png;base64,annotated",
      fileName: "annotated-page.png",
    });
    expect(draft?.modelContext.includes(JSON.stringify(page.browserTab))).toBe(kind === "remote");
    expect(draft).not.toHaveProperty("text");
  });

  it("distinguishes a rejected capture from an unhandled one", () => {
    const reject = (event: Event) => {
      (event as Event & { rejection?: "limit" }).rejection = "limit";
    };
    window.addEventListener(BROWSER_ANNOTATION_EVENT, reject);
    try {
      expect(capture(view())).toBe("rejected");
    } finally {
      window.removeEventListener(BROWSER_ANNOTATION_EVENT, reject);
    }
  });
});
