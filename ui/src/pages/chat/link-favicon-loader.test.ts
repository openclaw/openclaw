import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateLinkFavicons, resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function appendPlaceholder(): HTMLImageElement {
  const root = document.createElement("div");
  root.innerHTML =
    '<a href="https://docs.example.com"><img class="markdown-link-favicon" data-link-favicon-host="docs.example.com" alt=""></a>';
  document.body.append(root);
  return root.querySelector("img") as HTMLImageElement;
}

describe("hydrateLinkFavicons", () => {
  it("shares a hostname miss across transcript links and later renders", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const state = {
      automaticallyFetchFavicons: true,
      resourceBasePath: "",
      settings: { gatewayUrl: `ws://${window.location.host}`, token: "favicon-fixture" },
      client: null,
    };
    const images = Array.from({ length: 5 }, () => appendPlaceholder());
    hydrateLinkFavicons(document.body, resolveChatLinkFaviconFetcher(state));
    await vi.advanceTimersByTimeAsync(0);
    expect(images.every((image) => image.dataset.linkFaviconState === "failed")).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    const later = appendPlaceholder();
    hydrateLinkFavicons(document.body, resolveChatLinkFaviconFetcher({ ...state }));
    expect(later.dataset.linkFaviconState).toBe("failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not request favicons when disabled or the Gateway is remote", () => {
    const image = appendPlaceholder();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [automaticallyFetchFavicons, gatewayUrl] of [
      [false, `ws://${window.location.host}`],
      [true, "wss://different-gateway.example"],
    ] as const) {
      hydrateLinkFavicons(
        document.body,
        resolveChatLinkFaviconFetcher({
          automaticallyFetchFavicons,
          resourceBasePath: "",
          settings: { gatewayUrl },
          client: null,
        }),
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(image.dataset.linkFaviconState).toBeUndefined();
  });

  it("does nothing without an opt-in fetcher", () => {
    const image = appendPlaceholder();

    hydrateLinkFavicons(document.body);

    expect(image.hasAttribute("src")).toBe(false);
    expect(image.dataset.linkFaviconState).toBeUndefined();
  });

  it("loads each inert placeholder once and reveals only a decoded image", async () => {
    const image = appendPlaceholder();
    const fetcher = vi.fn().mockResolvedValue("blob:link-favicon");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 16 });

    hydrateLinkFavicons(document.body, fetcher);
    hydrateLinkFavicons(document.body, fetcher);
    await vi.waitFor(() => expect(image.src).toBe("blob:link-favicon"));
    image.dispatchEvent(new Event("load"));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("docs.example.com", expect.any(AbortSignal));
    expect(image.classList.contains("is-loaded")).toBe(true);
    expect(image.dataset.linkFaviconState).toBe("loaded");
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("leaves the link unchanged when the Gateway has no icon", async () => {
    const image = appendPlaceholder();
    const fetcher = vi.fn().mockResolvedValue(null);

    hydrateLinkFavicons(document.body, fetcher);
    await vi.waitFor(() => expect(image.dataset.linkFaviconState).toBe("failed"));

    expect(image.hasAttribute("src")).toBe(false);
    expect(image.classList.contains("is-loaded")).toBe(false);
  });
});
