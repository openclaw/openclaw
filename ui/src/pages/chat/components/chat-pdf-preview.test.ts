/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "./chat-detail-panel.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const PDF_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const source = "/__openclaw__/assistant-media?mediaTicket=pdf-preview";

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
    src: source,
    mimeType: "application/pdf",
    ...overrides,
  };
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function stubObjectUrls() {
  class TestURL extends URL {}
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

it.each(["metadata", "timeout"] as const)("declines a PDF after %s rejection", async (failure) => {
  const fetchMock = vi.fn<typeof fetch>();
  if (failure === "timeout") {
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
    expect(download?.getAttribute("href")).toBe(source);
    expect(download?.download).toBe("brief.pdf");
  }
});

it("aborts an interrupted PDF load and reloads it after reconnect", async () => {
  const objectUrls = stubObjectUrls();
  const download = vi.fn();
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
  const panel = await mountAttachment({
    sizeBytes: 8_231,
    file: { path: "brief.pdf", download },
  });

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  panel.remove();
  await waitForSolid(() => expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true));
  document.body.append(panel);
  await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(download).not.toHaveBeenCalled();
  expect(objectUrls.createObjectURL).toHaveBeenCalledOnce();
  expect(objectUrls.revokeObjectURL).not.toHaveBeenCalled();
  expect(panel.querySelector("iframe")?.getAttribute("src")).toBe("blob:pdf-preview");
  expect(panel.querySelector("iframe")).toHaveProperty("title", "brief.pdf");
  expect(fetchMock).toHaveBeenCalledWith(
    source,
    expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
  );
});

it.each(["oversized", "read failure", "grant failure"] as const)(
  "retains a fresh file download after PDF %s",
  async (failure) => {
    const download = vi.fn(async () => ({ url: source, filename: "brief.pdf" }));
    if (failure === "grant failure") {
      download.mockRejectedValueOnce(new Error("File unavailable"));
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const panel = await mountAttachment({
      src: undefined,
      sourceIdentity: "session-file:brief",
      sizeBytes: failure === "oversized" ? PDF_PREVIEW_MAX_BYTES + 1 : 100,
      file: { path: "brief.pdf", download },
    });
    await waitForSolid(() => expect(panel.querySelector("[role=alert]")).not.toBeNull());
    expect(panel.querySelector("iframe")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(failure === "read failure" ? 1 : 0);
    expect(download).toHaveBeenCalledTimes(failure === "oversized" ? 0 : 1);
    // Explicit download reauthorizes instead of reusing the failed/expired preview grant.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const button = panel.querySelector<HTMLButtonElement>("[role=alert] button");
    expect(button).not.toBeNull();
    button!.click();
    await waitForSolid(() =>
      expect(download).toHaveBeenCalledTimes(failure === "oversized" ? 1 : 2),
    );
  },
);

it("retires file PDF bytes and pending grants on replacement and closure", async () => {
  const urls = stubObjectUrls();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7 original"));
  vi.stubGlobal("fetch", fetcher);
  const pending = Promise.withResolvers<{ url: string; filename: string }>();
  const download = vi.fn(async (_signal: AbortSignal) => ({ url: source, filename: "brief.pdf" }));
  const panel = await mountAttachment({
    src: undefined,
    sourceIdentity: "session-file:original",
    file: { path: "brief.pdf", download },
  });
  await waitForSolid(() => expect(panel.querySelector("iframe")).not.toBeNull());
  const original = panel.querySelector("iframe")!;
  download.mockReturnValueOnce(pending.promise);
  panel.content = {
    ...panel.content,
    sourceIdentity: "session-file:replacement",
    file: { path: "replacement.pdf", download },
  };
  await waitForSolid(() => {
    expect(download).toHaveBeenCalledTimes(2);
    expect(original.isConnected).toBe(false);
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:pdf-preview");
  });
  panel.remove();
  await waitForSolid(() => expect(download.mock.calls[1]?.[0].aborted).toBe(true));
  pending.resolve({ url: source, filename: "replacement.pdf" });
  await waitForSolid(() => expect(panel.querySelector("iframe")).toBeNull());
  expect(fetcher).toHaveBeenCalledOnce();
  expect(urls.createObjectURL).toHaveBeenCalledOnce();
});

it.each(["unchanged", "changed", "failed", "identity", "oversized"] as const)(
  "revalidates a PDF ticket without keeping a stale reader: %s",
  async (change) => {
    const urls = stubObjectUrls();
    urls.createObjectURL.mockReturnValueOnce("blob:original").mockReturnValue("blob:replacement");
    const bytes = "%PDF-1.7 original";
    const refreshed = Promise.withResolvers<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(bytes))
      .mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal("fetch", fetchMock);
    const panel = await mountAttachment({ sourceIdentity: "attachment:brief" });
    const query = (selector: string) => panel.querySelector(selector);
    const readerSource = () => query("iframe")?.getAttribute("src");
    const expectSource = (src: string) => waitForSolid(() => expect(readerSource()).toBe(src));
    await expectSource("blob:original");
    const frame = query("iframe")!;

    panel.content = {
      ...panel.content,
      src: "/__openclaw__/assistant-media?mediaTicket=renewed",
      sourceIdentity: change === "identity" ? "attachment:other" : "attachment:brief",
      sizeBytes: change === "oversized" ? PDF_PREVIEW_MAX_BYTES + 1 : undefined,
    };
    await panel.updateComplete;
    await waitForSolid(() => {
      if (change === "identity" || change === "oversized") {
        expect(frame.isConnected).toBe(false);
        expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:original");
      } else {
        expect(query("iframe")).toBe(frame);
        expect(readerSource()).toBe("blob:original");
        expect(urls.revokeObjectURL).not.toHaveBeenCalled();
      }
    });
    if (change === "oversized") {
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(panel.querySelector("[role=alert]")).not.toBeNull();
      return;
    }

    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const response = new Response(change === "changed" ? "%PDF-1.7 updated!" : bytes, {
      headers: change === "failed" ? { "Content-Length": String(PDF_PREVIEW_MAX_BYTES + 1) } : {},
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    refreshed.resolve(response);
    await waitForSolid(() => {
      expect(urls.createObjectURL).toHaveBeenCalledTimes(
        change === "unchanged" || change === "failed" ? 1 : 2,
      );
      expect(urls.revokeObjectURL).toHaveBeenCalledTimes(change === "unchanged" ? 0 : 1);
      if (change === "failed") {
        expect(cancel).toHaveBeenCalledOnce();
        expect(query("iframe")).toBeNull();
        expect(query("a[download]")?.getAttribute("href")).toContain("renewed");
      } else {
        expect(readerSource()).toBe(change === "unchanged" ? "blob:original" : "blob:replacement");
        if (change !== "identity") {
          expect(query("iframe")).toBe(frame);
        }
      }
      if (change !== "unchanged") {
        expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:original");
      }
    });

    if (change === "failed") {
      const recovered = Promise.withResolvers<Response>();
      fetchMock.mockReturnValueOnce(recovered.promise);
      panel.content = {
        ...panel.content,
        src: "/__openclaw__/assistant-media?mediaTicket=recovered",
      };
      await panel.updateComplete;
      await waitForSolid(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(panel.querySelector(".sidebar-attachment-preview__loading")).not.toBeNull();
        expect(panel.querySelector("[role=alert]")).toBeNull();
        expect(panel.querySelector("iframe")).toBeNull();
      });
      recovered.resolve(new Response(bytes));
      await waitForSolid(() => {
        expect(panel.querySelector("iframe")?.getAttribute("src")).toBe("blob:replacement");
        expect(panel.querySelector("iframe")).not.toBe(frame);
        expect(urls.createObjectURL).toHaveBeenCalledTimes(2);
        expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:original");
        expect(panel.querySelector("[role=alert]")).toBeNull();
      });
    }
  },
);
