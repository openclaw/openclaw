/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportWidget,
  requestWidgetSnapshot,
  sanitizeWidgetExportTitle,
  validateWidgetSnapshotDataUrl,
} from "./widget-export.ts";

const PNG_DATA_URL = "data:image/png;base64,aW1hZ2U=";

function createWidgetFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = "/__openclaw__/canvas/documents/cv_export/index.html";
  document.body.append(frame);
  expect(frame.contentWindow).not.toBeNull();
  return frame;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("widget export", () => {
  it("matches snapshot replies by frame source and request id", async () => {
    const frame = createWidgetFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    let settled = false;
    const snapshot = requestWidgetSnapshot(frame, { id: "snapshot-1", timeoutMs: 1_000 });
    void snapshot.finally(() => {
      settled = true;
    });

    expect(postMessage).toHaveBeenCalledWith(
      { type: "openclaw:widget-snapshot-request", id: "snapshot-1" },
      "*",
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-snapshot", id: "snapshot-2", dataUrl: PNG_DATA_URL },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "openclaw:widget-snapshot", id: "snapshot-1", dataUrl: PNG_DATA_URL },
      }),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-snapshot", id: "snapshot-1", dataUrl: PNG_DATA_URL },
      }),
    );
    await expect(snapshot).resolves.toBe(PNG_DATA_URL);
  });

  it("selects the copy notice and HTML download fallbacks after a timeout", async () => {
    vi.useFakeTimers();
    const frame = createWidgetFrame();
    const fetchDocument = vi.fn(async () => new Response("<p>Legacy</p>", { status: 200 }));
    const download = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:legacy-widget");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const copyResult = exportWidget("copy", frame, "Legacy widget", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(copyResult).resolves.toBe("rerender-required");
    expect(fetchDocument).not.toHaveBeenCalled();

    const downloadResult = exportWidget("download", frame, "Legacy widget", {
      timeoutMs: 10,
      fetch: fetchDocument,
      download,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(downloadResult).resolves.toBe("html");
    expect(fetchDocument).toHaveBeenCalledWith(frame.src);
    expect(download).toHaveBeenCalledWith("blob:legacy-widget", "Legacy-widget.html");
  });

  it("starts clipboard writing before the snapshot resolves", async () => {
    const frame = createWidgetFrame();
    let resolveSnapshot: ((dataUrl: string) => void) | undefined;
    const snapshot = new Promise<string>((resolve) => {
      resolveSnapshot = resolve;
    });
    const copyImage = vi.fn(async (pending: Promise<string>) => {
      expect(pending).toBe(snapshot);
      await pending;
    });

    const result = exportWidget("copy", frame, "Current widget", {
      requestSnapshot: () => snapshot,
      copyImage,
    });
    expect(copyImage).toHaveBeenCalledOnce();
    resolveSnapshot?.(PNG_DATA_URL);
    await expect(result).resolves.toBe("png");
  });

  it("does not use legacy fallbacks for an explicit bridge error", async () => {
    const frame = createWidgetFrame();
    const fetchDocument = vi.fn();
    const captureError = new Error("canvas is not exportable");
    const result = exportWidget("download", frame, "Broken widget", {
      requestSnapshot: () => Promise.reject(captureError),
      fetch: fetchDocument,
    });

    await expect(result).rejects.toBe(captureError);
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("sanitizes widget titles and falls back to widget", () => {
    expect(sanitizeWidgetExportTitle("  Quarterly / status: Q3?  ")).toBe("Quarterly-status-Q3");
    expect(sanitizeWidgetExportTitle("... <> ")).toBe("widget");
    expect(sanitizeWidgetExportTitle(undefined)).toBe("widget");
  });

  it("accepts only bounded PNG data URLs", () => {
    expect(validateWidgetSnapshotDataUrl(PNG_DATA_URL)).toBe(true);
    expect(validateWidgetSnapshotDataUrl("data:image/jpeg;base64,aW1hZ2U=")).toBe(false);
    expect(validateWidgetSnapshotDataUrl("https://example.com/widget.png")).toBe(false);
    expect(
      validateWidgetSnapshotDataUrl(`data:image/png;base64,${"A".repeat(32 * 1024 * 1024)}`),
    ).toBe(false);
  });
});
