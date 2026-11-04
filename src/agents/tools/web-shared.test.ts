import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CacheEntry,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolvePositiveTimeoutSeconds,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

afterEach(() => vi.restoreAllMocks());

function responseFromReader(params: {
  chunks: string[];
  cancel?: () => Promise<void>;
  releaseLock?: () => void;
  contentType?: string;
}): Response {
  const chunks = params.chunks.map((chunk) => new TextEncoder().encode(chunk));
  const reader = {
    read: async () => {
      const value = chunks.shift();
      return value === undefined ? { done: true, value } : { done: false, value };
    },
    cancel: params.cancel ?? vi.fn(async () => undefined),
    releaseLock: params.releaseLock ?? vi.fn(),
  } as ReadableStreamDefaultReader<Uint8Array>;

  return {
    body: { getReader: () => reader },
    headers: new Headers({ "content-type": params.contentType ?? "text/plain; charset=utf-8" }),
  } as Response;
}

async function expectDecoded(bytes: Uint8Array<ArrayBuffer>, contentType: string, text: string) {
  for (const options of [undefined, { maxBytes: bytes.byteLength }]) {
    const response = new Response(bytes, { headers: { "content-type": contentType } });
    await expect(readResponseText(response, options)).resolves.toEqual({
      text,
      truncated: false,
      bytesRead: bytes.byteLength,
    });
  }
}

function expectRead(response: Response, maxBytes: number | undefined, text: string) {
  return expect(readResponseText(response, { maxBytes })).resolves.toEqual({
    text,
    truncated: false,
    bytesRead: new TextEncoder().encode(text).byteLength,
  });
}

describe("web shared helpers", () => {
  it.each([-3_600_000, 3_600_000])(
    "expires cached results by elapsed time after a wall step of %i",
    (step) => {
      const wall = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const elapsed = vi.spyOn(performance, "now").mockReturnValue(100);
      const cache = new Map<string, CacheEntry<string>>();
      writeCache(cache, "request", "original", 1000);
      wall.mockReturnValue(1_000_000 + step);
      elapsed.mockReturnValue(1099);
      expect(readCache(cache, "request")).toEqual({ value: "original", cached: true });
      elapsed.mockReturnValue(1100);
      expect(readCache(cache, "request")).toBeNull();
    },
  );
  it("trims cache-key framing without changing case-sensitive request components", () => {
    const key = "fetch:https://example.com/get?marker=OpenClawCase";
    expect(normalizeCacheKey(` ${key} `)).toBe(key);
    expect(normalizeCacheKey(key.toLowerCase())).toBe(key.toLowerCase());
    expect(normalizeCacheKey(key)).not.toBe(normalizeCacheKey(key.toLowerCase()));
  });
  it("preserves fallback and minimum behavior", () => {
    expect(resolveTimeoutSeconds(Number.NaN, 30)).toBe(30);
    expect(resolveTimeoutSeconds(0, 30)).toBe(1);
    expect(resolvePositiveTimeoutSeconds(0, 30)).toBe(30);
    expect(resolvePositiveTimeoutSeconds(1.9, 30)).toBe(1);
  });
});

describe("readResponseText", () => {
  const utf16le = Buffer.from("café 日本", "utf16le");
  const utf16be = Buffer.from(utf16le).swap16();
  const utf8 = new TextEncoder().encode("café 日本");
  it.each([
    [new Uint8Array([0xff, 0xfe, ...utf16le]), "text/html; charset=utf-8"],
    [new Uint8Array([0xfe, 0xff, ...utf16be]), "application/xml; charset=iso-8859-1"],
    [new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]), "text/plain; charset=iso-8859-1"],
  ] as const)("prioritizes byte-order marks over conflicting headers: %s", (bytes, contentType) =>
    expectDecoded(bytes, contentType, "café 日本"),
  );

  it.each([
    ['<meta charset="iso-8859-1"><p>café</p>', "latin1"],
    ['<meta name="description" content="<!--"><meta charset="windows-1252"><p>café</p>', "latin1"],
    ...[
      '<!-- <meta charset="windows-1252"> -->',
      '<!-- <meta charset="windows-1252"> --!>',
      '<!-- <meta http-equiv="Content-Type" content="text/html; charset=windows-1252"> -->',
      '<!-- <?xml version="1.0" encoding="windows-1252"?> -->',
    ].map((comment) => [`${comment}<meta charset="utf-8"><p>café 日本 😀</p>`] as const),
    ['<!-- <meta charset="windows-1252">' + " ".repeat(4096) + "café -->"],
    ['<?xml encoding="utf-16"?><rss>café</rss>', "utf8", "application/rss+xml"],
    ['<meta charset="UTF-16LE"><p>café</p>'],
    ['<meta http-equiv="Content-Type" content="text/html; charset=utf-16"><p>café</p>'],
  ] as const)(
    "decodes active metadata, not comments: %s",
    (text, encoding = "utf8", type?: string) =>
      expectDecoded(Buffer.from(text, encoding), type ?? "text/html", text),
  );

  it("keeps truncated fallback charset decoding isolated between responses", async () => {
    const response = (chunk: string) =>
      responseFromReader({
        chunks: [chunk],
        contentType: "text/plain; charset=x-unsupported-test",
      });
    await expect(readResponseText(response("ab😀cd"), { maxBytes: 3 })).resolves.toMatchObject({
      text: "ab",
      truncated: true,
    });
    await expectRead(response("cd"), 64, "cd");
  });

  it("does not mark exact-limit responses as truncated when followed by zero-byte chunks", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hel", "lo", ""],
      cancel,
      releaseLock,
    });

    await expectRead(response, 5, "hello");
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("treats a native bodyless response as empty when maxBytes is set", async () => {
    await expectRead(new Response(null, { status: 204 }), 4, "");
  });

  it("counts UTF-8 bytes in uncapped native responses", async () => {
    await expectRead(new Response("中文🔥"), undefined, "中文🔥");
  });

  it("rejects an unreadable uncapped native response", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("response read failed"));
        },
      }),
    );
    await expect(readResponseText(response)).rejects.toThrow("response read failed");
  });
});
