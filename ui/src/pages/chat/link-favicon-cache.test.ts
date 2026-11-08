import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createLinkFaviconReader,
  retainLinkFaviconCache,
  type LinkFaviconFetcher,
} from "./link-favicon-cache.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("link favicon readers", () => {
  it("reuses a favicon across row remounts until its transcript is disposed", async () => {
    const fetcher = vi.fn<LinkFaviconFetcher>().mockResolvedValue("blob:warm-favicon");
    const releaseTranscript = retainLinkFaviconCache(fetcher);
    const settled = createDeferred();
    const first = createLinkFaviconReader(settled.resolve);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    first.read("warm.example.com", fetcher);
    await settled.promise;
    first.dispose();
    expect(revoke).not.toHaveBeenCalled();
    const remounted = createLinkFaviconReader(() => undefined);
    expect(remounted.read("warm.example.com", fetcher)).toBe("blob:warm-favicon");
    expect(fetcher).toHaveBeenCalledOnce();
    releaseTranscript();
    expect(revoke).not.toHaveBeenCalled();
    remounted.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:warm-favicon");
  });

  it("bounds unused warm favicons while keeping displayed images alive", async () => {
    const fetcher = vi.fn<LinkFaviconFetcher>(async (hostname) => `blob:${hostname}`);
    const releaseTranscript = retainLinkFaviconCache(fetcher);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const visible = createLinkFaviconReader(() => undefined);
    visible.read("visible.example.com", fetcher);
    for (let index = 0; index < 129; index++) {
      const settled = createDeferred();
      const reader = createLinkFaviconReader(settled.resolve);
      reader.read(`${index}.example.com`, fetcher);
      await settled.promise;
      reader.dispose();
    }
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalledWith("blob:visible.example.com");
    releaseTranscript();
    visible.dispose();
    expect(revoke).toHaveBeenCalledTimes(130);
  });
  it("does not reuse a hostname miss across Gateway credential contexts", async () => {
    const first = vi.fn<LinkFaviconFetcher>().mockResolvedValue(null);
    const firstSettled = createDeferred();
    const reader = createLinkFaviconReader(firstSettled.resolve);
    reader.read("scoped.example.com", first);
    await firstSettled.promise;
    expect(reader.read("scoped.example.com", first)).toBeNull();
    expect(first).toHaveBeenCalledOnce();

    const replacement = vi.fn<LinkFaviconFetcher>().mockResolvedValue("blob:replacement");
    expect(reader.read("scoped.example.com", replacement)).toBeUndefined();
    await vi.waitFor(() =>
      expect(reader.read("scoped.example.com", replacement)).toBe("blob:replacement"),
    );
    reader.dispose();
  });

  it("shares one request and URL until the last mounted reader releases it", async () => {
    const pending = createDeferred<string | null>();
    const fetcher = vi.fn<LinkFaviconFetcher>().mockReturnValue(pending.promise);
    const onSettled = vi.fn();
    const anotherSubscriber = vi.fn();
    const first = createLinkFaviconReader(onSettled);
    const second = createLinkFaviconReader(anotherSubscriber);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const hostname = "ready.example.com";

    expect(first.read(hostname, fetcher)).toBeUndefined();
    expect(first.read(hostname, fetcher)).toBeUndefined();
    expect(second.read(hostname, fetcher)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(hostname, expect.any(AbortSignal));
    first.dispose();
    pending.resolve("blob:cached-favicon");
    await vi.waitFor(() => expect(anotherSubscriber).toHaveBeenCalledOnce());

    expect(onSettled).not.toHaveBeenCalled();
    expect(second.read(hostname, fetcher)).toBe("blob:cached-favicon");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    second.dispose();
    second.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-favicon");
  });

  it("aborts an unowned request and revokes a late result without retaining its reader", async () => {
    const pending = createDeferred<string | null>();
    const fetcher = vi.fn<LinkFaviconFetcher>().mockReturnValue(pending.promise);
    const onSettled = vi.fn();
    const reader = createLinkFaviconReader(onSettled);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    reader.read("retired.example.com", fetcher);
    const signal = fetcher.mock.calls[0]![1];
    reader.dispose();
    expect(signal.aborted).toBe(true);
    pending.resolve("blob:late-favicon");
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:late-favicon"));
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("caches a rejected favicon as null for its mounted reader", async () => {
    const fetcher = vi.fn<LinkFaviconFetcher>().mockRejectedValue(new Error("fetch failed"));
    const onSettled = vi.fn();
    const reader = createLinkFaviconReader(onSettled);
    expect(reader.read("rejected.example.com", fetcher)).toBeUndefined();
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(reader.read("rejected.example.com", fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    reader.dispose();
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
    const reader = createLinkFaviconReader(onSettled);
    expect(reader.read("timeout.example.com", fetcher)).toBeUndefined();
    const signal = fetcher.mock.calls[0]![1];
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal.aborted).toBe(false);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(reader.read("timeout.example.com", fetcher)).toBeNull();
    reader.dispose();
  });
});
