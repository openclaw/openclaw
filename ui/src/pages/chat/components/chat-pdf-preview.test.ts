/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import * as responseBytes from "./chat-response-bytes.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-sidebar.ts";

const PDF_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;

async function mountAttachment(
  overrides: Partial<Extract<SidebarContent, { kind: "attachment" }>> = {},
) {
  const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
    content: Extract<SidebarContent, { kind: "attachment" }>;
    updateComplete: Promise<unknown>;
  };
  panel.content = {
    kind: "attachment",
    attachmentKind: "document",
    title: "brief.pdf",
    src: "/__openclaw__/assistant-media?mediaTicket=pdf-preview",
    mimeType: "application/pdf",
    ...overrides,
  };
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function stubObjectUrls() {
  const NativeURL = URL;
  class TestURL extends NativeURL {}
  const createObjectURL = vi.fn(() => "blob:pdf-preview");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(TestURL, "createObjectURL", { value: createObjectURL });
  Object.defineProperty(TestURL, "revokeObjectURL", { value: revokeObjectURL });
  vi.stubGlobal("URL", TestURL);
  return { createObjectURL, revokeObjectURL };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("loads a bounded PDF into a CSP-compatible iframe", async () => {
  const objectUrls = stubObjectUrls();
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7"));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment({ sizeBytes: 8_231 });

  await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
  const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
  expect(frame.className).toBe("sidebar-pdf-preview__frame");
  expect(frame.getAttribute("src")).toBe("blob:pdf-preview");
  expect(frame.title).toBe("brief.pdf");
  expect(panel.querySelector(".sidebar-file-toolbar")).toBeNull();
  expect(panel.querySelector("object")).toBeNull();
  expect(objectUrls.createObjectURL).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(
    "/__openclaw__/assistant-media?mediaTicket=pdf-preview",
    expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
  );
});

it("does not fetch a PDF known to exceed the preview budget", async () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment({ sizeBytes: PDF_PREVIEW_MAX_BYTES + 1 });

  await vi.waitFor(() => expect(panel.textContent).toContain("Preview unavailable"));
  expect(panel.querySelector("iframe")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  const download = panel.querySelector<HTMLAnchorElement>("a[download]");
  expect(download?.getAttribute("href")).toBe(
    "/__openclaw__/assistant-media?mediaTicket=pdf-preview",
  );
  expect(download?.download).toBe("brief.pdf");
});

it("cancels an oversized streamed PDF response", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start() {}, cancel }), {
    headers: { "Content-Length": String(PDF_PREVIEW_MAX_BYTES + 1) },
  });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
  const panel = await mountAttachment();

  await vi.waitFor(() => expect(panel.textContent).toContain("Preview unavailable"));
  expect(cancel).toHaveBeenCalledOnce();
  expect(panel.querySelector("iframe")).toBeNull();
});

it("times out a PDF response that stalls while reading", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("Aborted", "AbortError")),
              );
            },
          }),
        ),
    ),
  );
  const panel = await mountAttachment();

  await vi.advanceTimersByTimeAsync(10_000);
  await vi.waitFor(() => expect(panel.textContent).toContain("Preview unavailable"));
  expect(panel.querySelector("iframe")).toBeNull();
});

it("aborts an interrupted PDF load and reloads it after reconnect", async () => {
  const objectUrls = stubObjectUrls();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    )
    .mockResolvedValueOnce(new Response("%PDF-1.7"));
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment();

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  panel.remove();
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  document.body.append(panel);
  await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(objectUrls.createObjectURL).toHaveBeenCalledOnce();
  expect(objectUrls.revokeObjectURL).not.toHaveBeenCalled();
});

it.each(["unchanged", "changed", "failed", "identity", "oversized"] as const)(
  "revalidates a PDF ticket without keeping a stale reader: %s",
  async (change) => {
    const urls = stubObjectUrls();
    urls.createObjectURL.mockReturnValueOnce("blob:original").mockReturnValue("blob:replacement");
    const original = createDeferred<ArrayBuffer | null>();
    const refreshed = createDeferred<ArrayBuffer | null>();
    const originalReadStarted = createDeferred();
    const refreshedReadStarted = createDeferred();
    const readBytes = vi
      .spyOn(responseBytes, "readResponseBytesWithinLimit")
      .mockImplementationOnce(() => {
        originalReadStarted.resolve();
        return original.promise;
      })
      .mockImplementationOnce(() => {
        refreshedReadStarted.resolve();
        return refreshed.promise;
      });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7")));
    const panel = await mountAttachment({ sourceIdentity: "attachment:brief" });
    const preview = panel.querySelector("openclaw-chat-pdf-preview")!;
    await preview.updateComplete;
    await originalReadStarted.promise;
    const bytes = new TextEncoder().encode("%PDF-1.7 original").buffer;
    original.resolve(bytes);
    await original.promise;
    await preview.updateComplete;
    const frame = panel.querySelector("iframe")!;
    expect(frame?.getAttribute("src")).toBe("blob:original");

    panel.content = {
      ...panel.content,
      kind: "attachment",
      src: "/__openclaw__/assistant-media?mediaTicket=renewed",
      sourceIdentity: change === "identity" ? "attachment:other" : "attachment:brief",
      sizeBytes: change === "oversized" ? PDF_PREVIEW_MAX_BYTES + 1 : undefined,
    };
    await panel.updateComplete;
    await preview.updateComplete;
    if (change === "identity" || change === "oversized") {
      expect(frame.isConnected).toBe(false);
      expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:original");
    } else {
      expect(panel.querySelector("iframe")).toBe(frame);
      expect(frame.getAttribute("src")).toBe("blob:original");
      expect(urls.revokeObjectURL).not.toHaveBeenCalled();
    }
    if (change === "oversized") {
      expect(readBytes).toHaveBeenCalledOnce();
      expect(panel.querySelector("[role=alert]")).not.toBeNull();
      return;
    }

    await refreshedReadStarted.promise;
    expect(readBytes).toHaveBeenCalledTimes(2);
    refreshed.resolve(
      change === "failed"
        ? null
        : change === "changed"
          ? new TextEncoder().encode("%PDF-1.7 updated!").buffer
          : bytes.slice(0),
    );
    await refreshed.promise;
    await preview.updateComplete;
    if (change === "unchanged") {
      expect(panel.querySelector("iframe")).toBe(frame);
      expect(frame.getAttribute("src")).toBe("blob:original");
      expect(urls.createObjectURL).toHaveBeenCalledOnce();
      expect(urls.revokeObjectURL).not.toHaveBeenCalled();
    } else {
      expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:original");
      if (change === "failed") {
        expect(panel.querySelector("iframe")).toBeNull();
        expect(panel.querySelector("a[download]")?.getAttribute("href")).toContain("renewed");
      } else {
        expect(panel.querySelector("iframe")?.getAttribute("src")).toBe("blob:replacement");
      }
    }
  },
);
