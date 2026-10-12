// Shared web helper tests cover timeout normalization, process-local cache
// expiry guards, and bounded response body cleanup.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolvePositiveTimeoutSeconds,
  resolveTimeoutSeconds,
  writeCache,
  type CacheEntry,
} from "./web-shared.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function responseFromReader(params: {
  chunks: string[];
  cancel: () => Promise<void>;
  releaseLock: () => void;
  contentType?: string;
  readError?: Error;
}): Response {
  const chunks: Array<ReadableStreamReadResult<Uint8Array>> = params.chunks.map((chunk) => ({
    done: false,
    value: new TextEncoder().encode(chunk),
  }));
  if (!params.readError) {
    chunks.push({ done: true, value: undefined });
  }
  const reader = {
    read: async () => {
      const next = chunks.shift();
      if (next) {
        return next;
      }
      if (params.readError) {
        throw params.readError;
      }
      return { done: true, value: undefined };
    },
    cancel: params.cancel,
    releaseLock: params.releaseLock,
  } as ReadableStreamDefaultReader<Uint8Array>;

  return {
    body: { getReader: () => reader },
    headers: new Headers({ "content-type": params.contentType ?? "text/plain; charset=utf-8" }),
  } as Response;
}

describe("web cache keys", () => {
  it("keeps case-sensitive request components distinct in cache keys", () => {
    const upper = normalizeCacheKey(" fetch:https://example.com/get?marker=OpenClawCase ");
    const lower = normalizeCacheKey("fetch:https://example.com/get?marker=openclawcase");

    expect(upper).toBe("fetch:https://example.com/get?marker=OpenClawCase");
    expect(lower).toBe("fetch:https://example.com/get?marker=openclawcase");
    expect(upper).not.toBe(lower);
  });
});

describe("web cache TTL", () => {
  it.each([{ ttlMs: 60_000, ageMs: 60_000, hit: false }])(
    "bounds reuse by current TTL $ttlMs at age $ageMs",
    ({ ttlMs, ageMs, hit }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const cache = new Map<string, CacheEntry<string>>();
      writeCache(cache, "key", "value", 900_000);
      clock.mockReturnValue(1_000 + ageMs);

      expect(readCache(cache, "key", ttlMs)).toEqual(hit ? { value: "value", cached: true } : null);
      if (ageMs < 900_000) {
        expect(readCache(cache, "key")).toEqual({ value: "value", cached: true });
      }
    },
  );
});

describe("web shared timeout seconds", () => {
  it("preserves fallback and minimum behavior", () => {
    expect(resolveTimeoutSeconds(Number.NaN, 30)).toBe(30);
    expect(resolveTimeoutSeconds(0, 30)).toBe(1);
    expect(resolvePositiveTimeoutSeconds(0, 30)).toBe(30);
    expect(resolvePositiveTimeoutSeconds(1.9, 30)).toBe(1);
  });

  it("drops cached values while the process clock is invalid", () => {
    // Bad system clocks can make cache expiry nonsensical; fail closed instead
    // of serving stale web data indefinitely.
    const cache = new Map<string, CacheEntry<string>>();
    writeCache(cache, "key", "old", 60_000);
    expect(readCache(cache, "key")?.value).toBe("old");

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    expect(readCache(cache, "key")).toBeNull();

    vi.mocked(Date.now).mockReturnValue(1_000);
    expect(readCache(cache, "key")).toBeNull();
  });

  it("does not write cache values when expiry would exceed the Date range", () => {
    const cache = new Map<string, CacheEntry<string>>();
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);

    writeCache(cache, "key", "value", 60_000);

    expect(cache.size).toBe(0);
    expect(readCache(cache, "key")).toBeNull();
  });

  it("does not evict valid entries when an invalid expiry cannot be cached", () => {
    const cache = new Map<string, CacheEntry<string>>();
    for (let index = 0; index < 100; index += 1) {
      writeCache(cache, `key-${index}`, `value-${index}`, 60_000);
    }
    expect(cache.get("key-0")?.value).toBe("value-0");

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    writeCache(cache, "invalid", "value", 60_000);

    expect(cache.size).toBe(100);
    expect(cache.get("key-0")?.value).toBe("value-0");
    expect(cache.has("invalid")).toBe(false);
  });
});

describe("readResponseText", () => {
  it.each([
    {
      name: "UTF-16LE HTML",
      bytes: new Uint8Array([0xff, 0xfe, ...Buffer.from("café 日本", "utf16le")]),
      contentType: "text/html; charset=utf-8",
    },
    {
      name: "UTF-16BE XML",
      bytes: new Uint8Array([0xfe, 0xff, ...Buffer.from("café 日本", "utf16le").swap16()]),
      contentType: "application/xml; charset=iso-8859-1",
    },
    {
      name: "UTF-8 plain text",
      bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("café 日本")]),
      contentType: "text/plain; charset=iso-8859-1",
    },
  ])(
    "prioritizes the $name byte-order mark over a conflicting header",
    async ({ bytes, contentType }) => {
      for (const options of [undefined, { maxBytes: bytes.byteLength }]) {
        const response = new Response(bytes, {
          headers: { "content-type": contentType },
        });

        await expect(readResponseText(response, options)).resolves.toEqual({
          text: "café 日本",
          truncated: false,
          bytesRead: bytes.byteLength,
        });
      }
    },
  );

  it("uses document metadata when there is no byte-order mark or declared charset", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="iso-8859-1"><p>caf'),
      0xe9,
      ...new TextEncoder().encode("</p>"),
    ]);
    const response = new Response(bytes, { headers: { "content-type": "text/html" } });

    await expect(readResponseText(response, { maxBytes: bytes.byteLength })).resolves.toMatchObject(
      {
        text: '<meta charset="iso-8859-1"><p>café</p>',
        truncated: false,
      },
    );
  });

  it("does not mark multi-chunk exact-limit streamed responses as truncated", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hel", "lo"],
      cancel,
      releaseLock,
    });

    await expect(readResponseText(response, { maxBytes: 5 })).resolves.toEqual({
      text: "hello",
      truncated: false,
      bytesRead: 5,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps truncated fallback charset decoding isolated between responses", async () => {
    const firstResponse = responseFromReader({
      chunks: ["ab😀cd"],
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
      contentType: "text/plain; charset=x-unsupported-test",
    });
    await expect(readResponseText(firstResponse, { maxBytes: 3 })).resolves.toMatchObject({
      text: "ab",
      truncated: true,
    });

    const secondResponse = responseFromReader({
      chunks: ["cd"],
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
      contentType: "text/plain; charset=x-unsupported-test",
    });
    await expect(readResponseText(secondResponse, { maxBytes: 64 })).resolves.toMatchObject({
      text: "cd",
      truncated: false,
    });
  });

  it("does not mark exact-limit responses as truncated when followed by zero-byte chunks", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hello", ""],
      cancel,
      releaseLock,
    });

    await expect(readResponseText(response, { maxBytes: 5 })).resolves.toEqual({
      text: "hello",
      truncated: false,
      bytesRead: 5,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not invoke whole-body fallbacks when maxBytes is set", async () => {
    const arrayBuffer = vi.fn(async () => new TextEncoder().encode("hello").buffer);
    const text = vi.fn(async () => "hello");
    const response = {
      arrayBuffer,
      headers: new Headers(),
      text,
    } as unknown as Response;

    await expect(readResponseText(response, { maxBytes: 4 })).resolves.toEqual({
      text: "",
      truncated: true,
      bytesRead: 0,
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("treats a native bodyless response as empty when maxBytes is set", async () => {
    await expect(
      readResponseText(new Response(null, { status: 204 }), { maxBytes: 4 }),
    ).resolves.toEqual({
      text: "",
      truncated: false,
      bytesRead: 0,
    });
  });

  it("preserves uncapped text-only fallback byte accounting", async () => {
    const value = "中文🔥";
    const text = vi.fn(async () => value);
    const response = {
      headers: new Headers(),
      text,
    } as unknown as Response;

    await expect(readResponseText(response)).resolves.toEqual({
      text: value,
      truncated: false,
      bytesRead: new TextEncoder().encode(value).byteLength,
    });
    expect(text).toHaveBeenCalledTimes(1);
  });
});
