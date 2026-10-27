import { afterEach, expect, it, vi } from "vitest";
import { stubManualIntersectionObserver } from "./components/chat-media-observer.test-support.ts";
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
  stubManualIntersectionObserver((element, notify) => enter.set(element, () => notify(true)));
  const first = appendPlaceholder();
  const second = appendPlaceholder();
  const fetcher = vi.fn().mockResolvedValue("blob:visible-favicon");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  Object.defineProperty(first, "naturalWidth", { configurable: true, value: 16 });
  hydrateLinkFavicons(document.body, fetcher);
  hydrateLinkFavicons(document.body, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  enter.get(first)?.();
  await vi.waitFor(() => expect(first.src).toBe("blob:visible-favicon"));
  first.dispatchEvent(new Event("load"));
  expect(first.classList.contains("is-loaded")).toBe(true);
  expect(first.dataset.linkFaviconState).toBe("loaded");
  enter.get(second)?.();
  expect(second.src).toBe(first.src);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("docs.example.com", expect.any(AbortSignal));
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
  const image = document.createElement("img");
  image.className = "markdown-link-favicon";
  image.dataset.linkFaviconHost = "docs.example.com";
  return document.body.appendChild(image);
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
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const images = Array.from({ length: 5 }, () => appendPlaceholder());
  hydrateLinkFavicons(document.body, resolveChatLinkFaviconFetcher(localState));
  await vi.advanceTimersByTimeAsync(0);
  expect(images.every((image) => image.dataset.linkFaviconState === "failed")).toBe(true);
  expect(images.every((image) => !image.hasAttribute("src"))).toBe(true);
  expect(images.every((image) => !image.classList.contains("is-loaded"))).toBe(true);
  expect(fetchMock).toHaveBeenCalledOnce();

  const later = appendPlaceholder();
  hydrateLinkFavicons(document.body, resolveChatLinkFaviconFetcher({ ...localState }));
  await vi.advanceTimersByTimeAsync(0);
  expect(later.dataset.linkFaviconState).toBe("failed");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(revoke).not.toHaveBeenCalled();
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
