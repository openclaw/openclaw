import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { readLinkFavicon } from "./link-favicon-cache.ts";
import type { LinkFaviconFetcher } from "./link-favicon-loader.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readLinkFavicon", () => {
  it("shares one in-flight fetch and notifies each subscriber once before reusing the URL", async () => {
    const pending = createDeferred<string | null>();
    const fetcher = vi.fn<LinkFaviconFetcher>().mockReturnValue(pending.promise);
    const onSettled = vi.fn();
    const anotherSubscriber = vi.fn();
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const hostname = "ready.example.com";

    expect(readLinkFavicon(hostname, fetcher, onSettled)).toBeUndefined();
    expect(readLinkFavicon(hostname, fetcher, onSettled)).toBeUndefined();
    expect(readLinkFavicon(hostname, fetcher, anotherSubscriber)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(hostname, expect.any(AbortSignal));
    expect(onSettled).not.toHaveBeenCalled();
    expect(anotherSubscriber).not.toHaveBeenCalled();

    pending.resolve("blob:cached-favicon");
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());

    expect(anotherSubscriber).toHaveBeenCalledOnce();
    expect(readLinkFavicon(hostname, fetcher, onSettled)).toBe("blob:cached-favicon");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });

  it.each(["missing", "rejected"] as const)("caches a %s favicon as null", async (outcome) => {
    const fetcher = vi.fn<LinkFaviconFetcher>();
    if (outcome === "missing") {
      fetcher.mockResolvedValue(null);
    } else {
      fetcher.mockRejectedValue(new Error("fetch failed"));
    }
    const onSettled = vi.fn();
    const hostname = `${outcome}.example.com`;

    expect(readLinkFavicon(hostname, fetcher, onSettled)).toBeUndefined();
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());

    expect(readLinkFavicon(hostname, fetcher, onSettled)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("aborts a stalled fetch after 15 seconds and settles as a known failure", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<LinkFaviconFetcher>(
      (_hostname, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    );
    const onSettled = vi.fn();
    const hostname = "timeout.example.com";

    expect(readLinkFavicon(hostname, fetcher, onSettled)).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect.assert(call);
    const signal = call[1];
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal.aborted).toBe(false);
    expect(onSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(readLinkFavicon(hostname, fetcher, onSettled)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
