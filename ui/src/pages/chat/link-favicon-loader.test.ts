import { afterEach, expect, it, vi } from "vitest";
import {
  hydrateLinkFavicons,
  releaseLinkFavicons,
  resolveChatLinkFaviconFetcher,
} from "./link-favicon-loader.ts";

afterEach(() => {
  releaseLinkFavicons(document.body);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("defers offscreen links and releases their shared URL after the last image leaves", async () => {
  const enter = new Map<Element, () => void>();
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "240px 0px";
      readonly scrollMargin = "0px";
      readonly thresholds = [0];
      constructor(private callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        enter.set(element, () => {
          const rect = element.getBoundingClientRect();
          this.callback(
            [
              {
                target: element,
                isIntersecting: true,
                intersectionRatio: 1,
                boundingClientRect: rect,
                intersectionRect: rect,
                rootBounds: rect,
                time: 0,
              },
            ],
            this,
          );
        });
      }
      unobserve(element: Element) {
        enter.delete(element);
      }
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  const first = appendPlaceholder();
  const second = appendPlaceholder();
  const fetcher = vi.fn().mockResolvedValue("blob:visible-favicon");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  hydrateLinkFavicons(document.body, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  enter.get(first)?.();
  await vi.waitFor(() => expect(first.src).toBe("blob:visible-favicon"));
  enter.get(second)?.();
  expect(second.src).toBe(first.src);
  expect(fetcher).toHaveBeenCalledOnce();
  const remounted = appendPlaceholder();
  hydrateLinkFavicons(document.body, fetcher);
  expect(remounted.src).toBe(first.src);
  expect(enter.has(remounted)).toBe(false);
  first.remove();
  hydrateLinkFavicons(document.body, fetcher);
  expect(revoke).not.toHaveBeenCalled();
  releaseLinkFavicons(document.body);
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:visible-favicon");
  expect(second.hasAttribute("src")).toBe(false);
});

function appendPlaceholder(): HTMLImageElement {
  const root = document.createElement("div");
  root.innerHTML =
    '<a href="https://docs.example.com"><img class="markdown-link-favicon" data-link-favicon-host="docs.example.com" alt=""></a>';
  document.body.append(root);
  return root.querySelector("img") as HTMLImageElement;
}

const localState = {
  automaticallyFetchFavicons: true,
  resourceBasePath: "",
  settings: { gatewayUrl: `ws://${window.location.host}`, token: "favicon-fixture" },
  client: null,
};

it("shares a hostname miss across transcript links and later renders", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  const images = Array.from({ length: 5 }, () => appendPlaceholder());
  hydrateLinkFavicons(document.body, resolveChatLinkFaviconFetcher(localState));
  await vi.advanceTimersByTimeAsync(0);
  expect(images.every((image) => image.dataset.linkFaviconState === "failed")).toBe(true);
  expect(fetchMock).toHaveBeenCalledOnce();

  const later = appendPlaceholder();
  hydrateLinkFavicons(document.body, resolveChatLinkFaviconFetcher({ ...localState }));
  await vi.advanceTimersByTimeAsync(0);
  expect(later.dataset.linkFaviconState).toBe("failed");
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([
  [false, `ws://${window.location.host}`],
  [true, "wss://different-gateway.example"],
] as const)(
  "does not fetch with opt-in=%s and Gateway=%s",
  (automaticallyFetchFavicons, gatewayUrl) => {
    const image = appendPlaceholder();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    hydrateLinkFavicons(
      document.body,
      resolveChatLinkFaviconFetcher({
        ...localState,
        automaticallyFetchFavicons,
        settings: { gatewayUrl },
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.dataset.linkFaviconState).toBeUndefined();
  },
);

it.each(["blob:link-favicon", null])(
  "settles %s once without revoking the cached URL",
  async (url) => {
    const image = appendPlaceholder();
    const fetcher = vi.fn().mockResolvedValue(url);
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 16 });

    hydrateLinkFavicons(document.body, fetcher);
    hydrateLinkFavicons(document.body, fetcher);
    if (url) {
      await vi.waitFor(() => expect(image.src).toBe(url));
      image.dispatchEvent(new Event("load"));
    } else {
      await vi.waitFor(() => expect(image.dataset.linkFaviconState).toBe("failed"));
      expect(image.hasAttribute("src")).toBe(false);
    }

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("docs.example.com", expect.any(AbortSignal));
    expect(image.classList.contains("is-loaded")).toBe(url !== null);
    expect(image.dataset.linkFaviconState).toBe(url ? "loaded" : "failed");
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  },
);
