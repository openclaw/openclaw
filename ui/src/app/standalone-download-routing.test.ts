import { afterEach, describe, expect, it, vi } from "vitest";
/* @vitest-environment jsdom */

const toastMock = vi.hoisted(() => ({ showToast: vi.fn(() => true) }));
vi.mock("../lib/toast.ts", () => toastMock);

import { startStandaloneDownloadRouting } from "./standalone-download-routing.ts";

const MEDIA_HREF = "/__openclaw__/assistant-media?source=docs%2Fbrochure.pdf&ticket=t1";

let routing: ReturnType<typeof startStandaloneDownloadRouting> | undefined;

const objectUrlDescriptors = {
  createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
  revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
};

function stubObjectUrls(createObjectURL: () => string) {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
}

afterEach(() => {
  for (const [name, descriptor] of Object.entries(objectUrlDescriptors)) {
    if (descriptor) {
      Object.defineProperty(URL, name, descriptor);
    } else {
      delete (URL as unknown as Record<string, unknown>)[name];
    }
  }
  routing?.dispose();
  routing = undefined;
  document.body.replaceChildren();
  toastMock.showToast.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setStandalone(standalone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: standalone && query === "(display-mode: standalone)" })),
  );
}

function stubFetch(body = "%PDF-1.4") {
  const fetchMock = vi.fn(
    async () => new Response(body, { status: 200, headers: { "content-type": "application/pdf" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubShare(share: (data: ShareData) => Promise<void>) {
  const shareMock = vi.fn(share);
  vi.stubGlobal("navigator", {
    canShare: (data: ShareData) => Boolean(data.files?.length),
    share: shareMock,
  });
  return shareMock;
}

function appendLink(href: string, attributes: Record<string, string> = {}) {
  const anchor = document.createElement("a");
  anchor.href = href;
  for (const [name, value] of Object.entries(attributes)) {
    anchor.setAttribute(name, value);
  }
  document.body.append(anchor);
  return anchor;
}

function click(anchor: HTMLAnchorElement) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  anchor.dispatchEvent(event);
  return event;
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("startStandaloneDownloadRouting", () => {
  it("shares a download link's file from a home screen app instead of navigating", async () => {
    setStandalone(true);
    const fetchMock = stubFetch();
    const share = stubShare(async () => undefined);
    routing = startStandaloneDownloadRouting();
    const anchor = appendLink(MEDIA_HREF, { download: "brochure.pdf", target: "_blank" });

    expect(click(anchor).defaultPrevented).toBe(true);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(MEDIA_HREF);
    expect(share).toHaveBeenCalledTimes(1);
    const file = share.mock.calls[0]?.[0].files?.[0];
    expect(file?.name).toBe("brochure.pdf");
    expect(file?.type).toBe("application/pdf");
  });

  it("downloads through a blob URL when the app cannot share files", async () => {
    setStandalone(true);
    stubFetch();
    vi.stubGlobal("navigator", { canShare: undefined, share: undefined });
    const createObjectURL = vi.fn(() => "blob:http://localhost/1");
    stubObjectUrls(createObjectURL);
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    routing = startStandaloneDownloadRouting();

    expect(click(appendLink(MEDIA_HREF, { download: "brochure.pdf" })).defaultPrevented).toBe(true);
    await settle();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([{ href: "blob:http://localhost/1", download: "brochure.pdf" }]);
  });

  it("offers a save action when the share sheet needs a fresh tap", async () => {
    setStandalone(true);
    stubFetch();
    let calls = 0;
    const share = stubShare(async () => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException("activation expired", "NotAllowedError");
      }
    });
    routing = startStandaloneDownloadRouting();

    click(appendLink(MEDIA_HREF, { download: "brochure.pdf" }));
    await settle();

    expect(toastMock.showToast).toHaveBeenCalledTimes(1);
    const toast = (toastMock.showToast.mock.calls[0] as unknown[])[0] as {
      onAction?: () => void;
    };
    toast.onAction?.();
    expect(share).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when the user closes the share sheet", async () => {
    setStandalone(true);
    stubFetch();
    stubShare(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    routing = startStandaloneDownloadRouting();

    click(appendLink(MEDIA_HREF, { download: "brochure.pdf" }));
    await settle();

    expect(toastMock.showToast).not.toHaveBeenCalled();
  });

  it("reports a share sheet that fails to take the file", async () => {
    setStandalone(true);
    stubFetch();
    stubShare(async () => {
      throw new DOMException("transfer failed", "DataError");
    });
    routing = startStandaloneDownloadRouting();

    click(appendLink(MEDIA_HREF, { download: "brochure.pdf" }));
    await settle();

    expect(toastMock.showToast).toHaveBeenCalledTimes(1);
    expect(toastMock.showToast).toHaveBeenCalledWith({
      message: expect.stringContaining("brochure.pdf"),
    });
  });

  it("reports a failed fetch without leaving the app", async () => {
    setStandalone(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    const share = stubShare(async () => undefined);
    routing = startStandaloneDownloadRouting();

    expect(click(appendLink(MEDIA_HREF, { download: "brochure.pdf" })).defaultPrevented).toBe(true);
    await settle();

    expect(share).not.toHaveBeenCalled();
    expect(toastMock.showToast).toHaveBeenCalledTimes(1);
  });

  it("keeps native download links in a regular browser tab", () => {
    setStandalone(false);
    const fetchMock = stubFetch();
    routing = startStandaloneDownloadRouting();

    expect(click(appendLink(MEDIA_HREF, { download: "brochure.pdf" })).defaultPrevented).toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a raw gateway file link in a new browsing context", () => {
    setStandalone(false);
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    routing = startStandaloneDownloadRouting();

    expect(click(appendLink(MEDIA_HREF)).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}${MEDIA_HREF}`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("leaves app routes, new-tab links and handled clicks alone", () => {
    setStandalone(true);
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    routing = startStandaloneDownloadRouting();

    expect(click(appendLink("/chat/main")).defaultPrevented).toBe(false);
    expect(click(appendLink(MEDIA_HREF, { target: "_blank" })).defaultPrevented).toBe(false);
    const handled = appendLink(MEDIA_HREF, { download: "brochure.pdf" });
    handled.addEventListener("click", (event) => event.preventDefault());
    const fetchMock = stubFetch();
    click(handled);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
