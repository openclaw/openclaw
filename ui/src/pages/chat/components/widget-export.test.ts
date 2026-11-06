/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { exportWidget } from "./widget-export.ts";

const PNG_DATA_URL = "data:image/png;base64,aW1hZ2U=";

function createWidgetFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = "/__openclaw__/canvas/documents/cv_export/index.html";
  return document.body.appendChild(frame);
}

function snapshot(title = "Current widget", action: "copy" | "download" = "download", stub = true) {
  const frame = createWidgetFrame();
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  if (stub) {
    postMessage.mockImplementation(() => {});
  }
  return {
    postMessage,
    result: exportWidget(action, frame, title),
    reply: (
      payload: { dataUrl?: string; error?: string; id?: string } = { dataUrl: PNG_DATA_URL },
      source: MessageEventSource | null = frame.contentWindow,
    ) => {
      const request = postMessage.mock.calls[0]?.[0] as { id: string };
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          data: { type: "openclaw:widget-snapshot", id: request.id, ...payload },
        }),
      );
    },
  };
}

function watchDownloads() {
  const anchors: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchors.push(this);
  });
  return () => anchors.map(({ href, download }) => [href, download]);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([
  ["Current widget", "Current-widget.png"],
  ["... <> ", "widget.png"],
])("matches snapshot replies and sanitizes %s", async (title, filename) => {
  const downloads = watchDownloads();
  const { postMessage, reply, result } = snapshot(title);
  let settled = false;
  void result.finally(() => {
    settled = true;
  });

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "openclaw:widget-snapshot-request" }),
    "*",
  );
  reply({ dataUrl: PNG_DATA_URL, id: "snapshot-2" });
  reply({ dataUrl: PNG_DATA_URL }, window);
  await Promise.resolve();
  expect(settled).toBe(false);

  reply();
  await expect(result).resolves.toBe("png");
  expect(downloads()).toEqual([[PNG_DATA_URL, filename]]);
});

it.each([
  ["Legacy", undefined],
  ["Isolated", "<p>Authenticated document</p>"],
] as const)("exports %s HTML after a snapshot timeout", async (kind, documentHtml) => {
  vi.useFakeTimers();
  const frame = createWidgetFrame();
  const downloads = watchDownloads();
  const fetchDocument = vi.fn(async () => new Response("<p>Legacy</p>", { status: 200 }));
  vi.stubGlobal("fetch", fetchDocument);
  const url = `blob:${kind}`;
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  if (documentHtml === undefined) {
    const copyResult = exportWidget("copy", frame, `${kind} widget`);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(copyResult).resolves.toBe("rerender-required");
    expect(fetchDocument).not.toHaveBeenCalled();
  } else {
    frame.src = "https://sandbox.example/mcp-app-sandbox";
  }
  const downloadResult = exportWidget("download", frame, `${kind} widget`, { documentHtml });
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(downloadResult).resolves.toBe("html");
  if (documentHtml === undefined) {
    expect(fetchDocument).toHaveBeenCalledWith(frame.src);
  } else {
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(createUrl.mock.calls[0]?.[0]).toMatchObject({ size: 29, type: "text/html" });
  }
  expect(downloads()).toEqual([[url, `${kind}-widget.html`]]);
});

it("starts clipboard writing before the snapshot resolves", async () => {
  const blob = new Blob(["image"], { type: "image/png" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: async () => blob }));
  class ClipboardItemStub {
    constructor(readonly data: Record<string, Promise<Blob>>) {}
  }
  vi.stubGlobal("ClipboardItem", ClipboardItemStub);
  const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
    await expect(items[0]?.data["image/png"]).resolves.toBe(blob);
  });
  vi.stubGlobal("navigator", { clipboard: { write } });

  const { reply, result } = snapshot("Current widget", "copy");
  expect(write).toHaveBeenCalledOnce();
  reply();
  await expect(result).resolves.toBe("png");
});

it.each([
  ["bridge error", { error: "canvas is not exportable" }],
  ["JPEG", { dataUrl: "data:image/jpeg;base64,aW1hZ2U=" }],
  ["URL", { dataUrl: "https://example.com/widget.png" }],
  ["oversized PNG", { dataUrl: `data:image/png;base64,${"A".repeat(32 * 1024 * 1024)}` }],
] as const)("rejects %s without a legacy fallback", async (_label, payload) => {
  const fetchDocument = vi.fn();
  vi.stubGlobal("fetch", fetchDocument);
  const error = "error" in payload ? payload.error : undefined;
  const { postMessage, reply, result } = snapshot("Broken widget", "download", Boolean(error));
  expect(postMessage).toHaveBeenCalledOnce();
  reply(payload);
  await expect(result).rejects.toThrow(error ?? "widget returned an invalid snapshot");
  expect(fetchDocument).not.toHaveBeenCalled();
});
