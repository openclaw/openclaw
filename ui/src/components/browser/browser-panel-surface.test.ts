import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserAnnotationDraft } from "./browser-annotation.ts";
import { setupAnnotationCapture } from "./browser-panel-capture.test-support.ts";
import { createView } from "./browser-panel-controller-test-support.ts";
import {
  dispatchCompositedBrowserAnnotation,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";

const { receive, stubCanvas } = setupAnnotationCapture();
let canvas: ReturnType<typeof stubCanvas>;
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
  canvas = stubCanvas(["beginPath", "moveTo", "lineTo", "stroke"]);
});
afterEach(() => vi.restoreAllMocks());

it.each(["remote", "native"] as const)("retries %s annotation drafts", (kind) => {
  const page = view(kind);
  expect(capture(page)).toBe("unhandled");
  expect(canvas.drawImage).toHaveBeenCalledTimes(1);
  expect(canvas.toDataURL).toHaveBeenCalledTimes(1);

  receive.mockImplementation((event) => event.preventDefault());
  expect(capture(page)).toBe("accepted");
  const draft = (receive.mock.lastCall![0] as CustomEvent<BrowserAnnotationDraft>).detail;

  expect(canvas.drawImage).toHaveBeenCalledTimes(2);
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
  expect(draft.modelContext.includes(JSON.stringify(page.browserTab))).toBe(kind === "remote");
  expect(draft).not.toHaveProperty("text");
});

it("distinguishes a rejected capture from an unhandled one", () => {
  receive.mockImplementation((event) => {
    (event as Event & { rejection?: "limit" }).rejection = "limit";
  });
  expect(capture(view())).toBe("rejected");
});
