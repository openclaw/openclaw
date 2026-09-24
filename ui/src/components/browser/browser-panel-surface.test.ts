import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_ANNOTATION_EVENT, type BrowserAnnotationDraft } from "./browser-annotation.ts";
import {
  browserPanelNormalizedPoint,
  dispatchCompositedBrowserAnnotation,
  paintBrowserPanelOverlay,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";

describe("browserPanelNormalizedPoint", () => {
  it("maps pointers against the rendered frame box when present", () => {
    const stage = document.createElement("div");
    const shot = document.createElement("img");
    shot.className = "bp-shot";
    stage.appendChild(shot);
    vi.spyOn(shot, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      width: 200,
      height: 100,
    } as DOMRect);
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 400,
    } as DOMRect);
    expect(browserPanelNormalizedPoint(stage, { clientX: 110, clientY: 70 } as MouseEvent)).toEqual(
      { x: 0.5, y: 0.5 },
    );
  });

  it("falls back to the stage when no frame is rendered", () => {
    const stage = document.createElement("div");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 200,
    } as DOMRect);
    expect(browserPanelNormalizedPoint(stage, { clientX: 100, clientY: 50 } as MouseEvent)).toEqual(
      { x: 0.25, y: 0.25 },
    );
  });
});

describe("dispatchCompositedBrowserAnnotation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["remote", "native"] as const)(
    "keeps an unconsumed %s annotation retryable and dispatches the canonical draft",
    (kind) => {
      const drawImage = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage,
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
      const toDataUrl = vi
        .spyOn(HTMLCanvasElement.prototype, "toDataURL")
        .mockReturnValue("data:image/png;base64,annotated");
      const view = {
        kind,
        browserTab: { target: "host", profile: "managed", targetId: "tab-1" },
        targetId: "tab-1",
        dataUrl: "data:image/png;base64,source",
        image: { naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement,
        url: "https://user:secret@example.com/path",
        metrics: null,
      } satisfies BrowserPanelView;
      const strokes = [{ points: [{ x: 0.25, y: 0.5 }] }];

      expect(dispatchCompositedBrowserAnnotation(view, undefined, strokes, null, null)).toBe(
        "unhandled",
      );
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(toDataUrl).toHaveBeenCalledTimes(1);

      let draft: BrowserAnnotationDraft | undefined;
      const consume = (event: Event) => {
        draft = (event as CustomEvent<BrowserAnnotationDraft>).detail;
        event.preventDefault();
      };
      window.addEventListener(BROWSER_ANNOTATION_EVENT, consume);
      try {
        expect(dispatchCompositedBrowserAnnotation(view, undefined, strokes, null, null)).toBe(
          "accepted",
        );
      } finally {
        window.removeEventListener(BROWSER_ANNOTATION_EVENT, consume);
      }

      expect(drawImage).toHaveBeenCalledTimes(2);
      expect(toDataUrl).toHaveBeenCalledTimes(2);
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
      expect(draft?.modelContext.includes(JSON.stringify(view.browserTab))).toBe(kind === "remote");
      expect(draft).not.toHaveProperty("text");
    },
  );

  it("distinguishes a rejected capture from an unhandled one", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,annotated",
    );
    const reject = (event: Event) => {
      (event as Event & { rejection?: "limit" }).rejection = "limit";
    };
    window.addEventListener(BROWSER_ANNOTATION_EVENT, reject);
    try {
      expect(
        dispatchCompositedBrowserAnnotation(
          {
            targetId: "tab-1",
            dataUrl: "data:image/png;base64,source",
            image: { naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement,
            url: "https://example.com",
            metrics: null,
          },
          undefined,
          [{ points: [{ x: 0.25, y: 0.5 }] }],
          null,
          null,
        ),
      ).toBe("rejected");
    } finally {
      window.removeEventListener(BROWSER_ANNOTATION_EVENT, reject);
    }
  });
});

describe("browser panel frame geometry", () => {
  function letterboxedStage() {
    const stage = document.createElement("div");
    const shot = document.createElement("img");
    shot.className = "bp-shot";
    stage.appendChild(shot);
    // A 1280x720 remote frame contained in a 1000x250 stage: painted area is
    // 444.4x250, centered at (277.8, 0) inside the stage.
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 250));
    vi.spyOn(shot, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 250));
    Object.defineProperty(shot, "naturalWidth", { value: 1280 });
    Object.defineProperty(shot, "naturalHeight", { value: 720 });
    return { stage, shot };
  }

  it("maps pointer coordinates against the letterboxed painted frame", () => {
    const { stage } = letterboxedStage();

    const center = browserPanelNormalizedPoint(
      stage,
      new MouseEvent("click", { clientX: 500, clientY: 125 }),
    );
    expect(center).not.toBeNull();
    expect(center!.x).toBeCloseTo(0.5, 3);
    expect(center!.y).toBeCloseTo(0.5, 3);

    // The letterbox margin is not part of the frame.
    const outside = browserPanelNormalizedPoint(
      stage,
      new MouseEvent("click", { clientX: 10, clientY: 125 }),
    );
    expect(outside).toBeNull();
  });

  it("paints annotations translated to the painted frame box", () => {
    const { stage } = letterboxedStage();
    Object.defineProperty(stage, "clientWidth", { value: 1000 });
    Object.defineProperty(stage, "clientHeight", { value: 250 });
    const context = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const canvas = document.createElement("canvas");

    paintBrowserPanelOverlay(canvas, stage, [{ points: [{ x: 0.5, y: 0.5 }] }], null);

    // Painted frame: 444x250 at (278, 0) inside the 1000x250 stage.
    expect(context.translate).toHaveBeenCalledWith(278, 0);
    expect(context.moveTo).toHaveBeenCalledWith(222, 125);
  });
});
