/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportWidget } from "./widget-export.ts";

const PNG_DATA_URL = "data:image/png;base64,aW1hZ2U=";

function createWidgetFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = "/__openclaw__/canvas/documents/cv_export/index.html";
  document.body.append(frame);
  expect(frame.contentWindow).not.toBeNull();
  return frame;
}

function watchSnapshot(frame: HTMLIFrameElement) {
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  return {
    postMessage,
    reply: (payload: { dataUrl: string } | { error: string }) => {
      const request = postMessage.mock.calls[0]?.[0] as { id: string };
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "openclaw:widget-snapshot", id: request.id, ...payload },
        }),
      );
    },
  };
}

function watchDownloads() {
  const downloads: Array<[string, string]> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push([this.href, this.download]);
  });
  return downloads;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("widget export", () => {
  it("matches snapshot replies by frame source and request id", async () => {
    const frame = createWidgetFrame();
    const { postMessage, reply } = watchSnapshot(frame);
    const downloads = watchDownloads();
    let settled = false;
    const result = exportWidget("download", frame, "Current widget");
    void result.finally(() => {
      settled = true;
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openclaw:widget-snapshot-request" }),
      "*",
    );
    const request = postMessage.mock.calls[0]?.[0] as { id: string };
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "openclaw:widget-snapshot", id: "snapshot-2", dataUrl: PNG_DATA_URL },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "openclaw:widget-snapshot", id: request.id, dataUrl: PNG_DATA_URL },
      }),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    reply({ dataUrl: PNG_DATA_URL });
    await expect(result).resolves.toBe("png");
    expect(downloads).toEqual([[PNG_DATA_URL, "Current-widget.png"]]);
  });

  it("selects the copy notice and HTML download fallbacks after a timeout", async () => {
    vi.useFakeTimers();
    const frame = createWidgetFrame();
    const fetchDocument = vi.fn(async () => new Response("<p>Legacy</p>", { status: 200 }));
    const downloads = watchDownloads();
    vi.stubGlobal("fetch", fetchDocument);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:legacy-widget");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const copyResult = exportWidget("copy", frame, "Legacy widget");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(copyResult).resolves.toBe("rerender-required");
    expect(fetchDocument).not.toHaveBeenCalled();

    const downloadResult = exportWidget("download", frame, "Legacy widget");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(downloadResult).resolves.toBe("html");
    expect(fetchDocument).toHaveBeenCalledWith(frame.src);
    expect(downloads).toEqual([["blob:legacy-widget", "Legacy-widget.html"]]);
  });

  it("starts clipboard writing before the snapshot resolves", async () => {
    const frame = createWidgetFrame();
    const { reply } = watchSnapshot(frame);
    const blob = new Blob(["image"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ blob: async () => blob })),
    );
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
      },
    );
    const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
      await expect(items[0]?.data["image/png"]).resolves.toBe(blob);
    });
    vi.stubGlobal("navigator", { clipboard: { write } });

    const result = exportWidget("copy", frame, "Current widget");
    expect(write).toHaveBeenCalledOnce();
    reply({ dataUrl: PNG_DATA_URL });
    await expect(result).resolves.toBe("png");
  });

  it("downloads retained authenticated HTML when an isolated widget cannot snapshot", async () => {
    vi.useFakeTimers();
    const frame = createWidgetFrame();
    frame.src = "https://sandbox.example/mcp-app-sandbox";
    const fetchDocument = vi.fn();
    const downloads = watchDownloads();
    vi.stubGlobal("fetch", fetchDocument);
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:widget-source");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const result = exportWidget("download", frame, "Isolated widget", {
      documentHtml: "<p>Authenticated document</p>",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe("html");
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(createUrl.mock.calls[0]?.[0]).toMatchObject({ size: 29, type: "text/html" });
    expect(downloads).toEqual([["blob:widget-source", "Isolated-widget.html"]]);
  });

  it("does not use legacy fallbacks for an explicit bridge error", async () => {
    const frame = createWidgetFrame();
    const fetchDocument = vi.fn();
    vi.stubGlobal("fetch", fetchDocument);
    const { reply } = watchSnapshot(frame);
    const result = exportWidget("download", frame, "Broken widget");
    reply({ error: "canvas is not exportable" });

    await expect(result).rejects.toThrow("canvas is not exportable");
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["  Quarterly / status: Q3?  ", "Quarterly-status-Q3.png"],
    ["... <> ", "widget.png"],
    [`${"a".repeat(119)}📊`, `${"a".repeat(119)}.png`],
  ])("sanitizes PNG download filename %s", async (title, filename) => {
    const frame = createWidgetFrame();
    const downloads = watchDownloads();
    const { reply } = watchSnapshot(frame);
    const result = exportWidget("download", frame, title);
    reply({ dataUrl: PNG_DATA_URL });
    await expect(result).resolves.toBe("png");
    expect(downloads).toEqual([[PNG_DATA_URL, filename]]);
  });

  it("rejects non-PNG and oversized snapshot replies", async () => {
    for (const dataUrl of [
      "data:image/jpeg;base64,aW1hZ2U=",
      "https://example.com/widget.png",
      `data:image/png;base64,${"A".repeat(32 * 1024 * 1024)}`,
    ]) {
      const frame = createWidgetFrame();
      const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
      const result = exportWidget("download", frame, "Current widget");
      expect(postMessage).toHaveBeenCalledOnce();
      const request = postMessage.mock.calls[0]?.[0];
      expect(request).toBeDefined();
      const id = (request as { id: string }).id;
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "openclaw:widget-snapshot", id, dataUrl },
        }),
      );
      await expect(result).rejects.toThrow("widget returned an invalid snapshot");
    }
  });
});
