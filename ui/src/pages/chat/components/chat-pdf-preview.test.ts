/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import * as responseBytes from "./chat-response-bytes.ts";
import "./chat-detail-panel.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const PDF_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const ticket = "/__openclaw__/assistant-media?mediaTicket=pdf-preview";
type Attachment = Extract<SidebarContent, { kind: "attachment" }>;

async function mountAttachment(overrides: Partial<Attachment> = {}) {
  const panel = Object.assign(document.createElement("openclaw-chat-detail-panel"), {
    content: {
      kind: "attachment",
      attachmentKind: "document",
      title: "brief.pdf",
      src: ticket,
      mimeType: "application/pdf",
      ...overrides,
    } satisfies Attachment,
  });
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function stubObjectUrls() {
  class TestURL extends URL {
    static createObjectURL = vi.fn(() => "blob:pdf-preview");
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal("URL", TestURL);
  return TestURL;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["metadata", "header", "timeout"] as const)("rejects PDF: %s", async (failure) => {
  const fetchMock = vi.fn<typeof fetch>();
  const cancel = vi.fn();
  if (failure === "header") {
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream({ start() {}, cancel }), {
        headers: { "Content-Length": String(PDF_PREVIEW_MAX_BYTES + 1) },
      }),
    );
  } else if (failure === "timeout") {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
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
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  const panel = await mountAttachment({
    sizeBytes: failure === "metadata" ? PDF_PREVIEW_MAX_BYTES + 1 : undefined,
  });
  if (failure === "timeout") {
    await vi.advanceTimersByTimeAsync(10_000);
  }
  await vi.waitFor(() => expect(panel.textContent).toContain("Preview unavailable"));
  expect(panel.querySelector("iframe")).toBeNull();
  if (failure === "metadata") {
    expect(fetchMock).not.toHaveBeenCalled();
    const download = panel.querySelector<HTMLAnchorElement>("a[download]");
    expect([download?.getAttribute("href"), download?.download]).toEqual([ticket, "brief.pdf"]);
  } else if (failure === "header") {
    expect(cancel).toHaveBeenCalledOnce();
  }
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
  const panel = await mountAttachment({ sizeBytes: 8_231 });

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  panel.remove();
  await waitForSolid(() => expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true));
  document.body.append(panel);
  await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(objectUrls.createObjectURL).toHaveBeenCalledOnce();
  expect(objectUrls.revokeObjectURL).not.toHaveBeenCalled();
  expect(panel.querySelector("iframe")).toMatchObject({
    className: "sidebar-pdf-preview__frame",
    src: "blob:pdf-preview",
    title: "brief.pdf",
  });
  expect(panel.querySelector(".sidebar-file-toolbar, object")).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith(
    ticket,
    expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
  );
});

it.each(["unchanged", "changed", "failed", "identity", "oversized"] as const)(
  "revalidates PDF ticket: %s",
  async (change) => {
    const urls = stubObjectUrls();
    urls.createObjectURL.mockReturnValueOnce("blob:original").mockReturnValue("blob:replacement");
    const original = createDeferred<ArrayBuffer | null>();
    const refreshed = createDeferred<ArrayBuffer | null>();
    const readBytes = vi
      .spyOn(responseBytes, "readResponseBytesWithinLimit")
      .mockReturnValueOnce(original.promise)
      .mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7")));
    const panel = await mountAttachment({ sourceIdentity: "attachment:brief" });
    const preview = panel.querySelector("openclaw-chat-pdf-preview")!;
    await preview.updateComplete;
    await waitForSolid(() => expect(readBytes).toHaveBeenCalledOnce());
    const bytes = new TextEncoder().encode("%PDF-1.7 original").buffer;
    original.resolve(bytes);
    await original.promise;
    await preview.updateComplete;
    const frame = panel.querySelector("iframe")!;
    expect(frame?.getAttribute("src")).toBe("blob:original");

    panel.content = {
      ...panel.content,
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

    await waitForSolid(() => expect(readBytes).toHaveBeenCalledTimes(2));
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
