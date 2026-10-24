import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeCacheKey,
  readResponseText,
  resolvePositiveTimeoutSeconds,
  resolveTimeoutSeconds,
} from "./web-shared.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("web shared helpers", () => {
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

  it("uses document metadata when there is no byte-order mark or declared charset", async () => {
    const bytes = Buffer.from('<meta charset="iso-8859-1"><p>café</p>', "latin1");
    const response = new Response(bytes, { headers: { "content-type": "text/html" } });

    await expect(readResponseText(response, { maxBytes: bytes.byteLength })).resolves.toMatchObject(
      {
        text: '<meta charset="iso-8859-1"><p>café</p>',
        truncated: false,
      },
    );
  });

  it.each([
    [
      '<?xml version="1.0" encoding="utf-16"?><rss><title>café</title></rss>',
      "application/rss+xml",
    ],
    ['<meta charset="UTF-16LE"><p>café</p>', "text/html"],
    [
      '<meta http-equiv="Content-Type" content="text/html; charset=utf-16"><p>café</p>',
      "text/html",
    ],
  ])("decodes ASCII-compatible documents declaring UTF-16 as UTF-8: %s", (body, contentType) =>
    expectDecoded(new TextEncoder().encode(body), contentType, body),
  );

  it("keeps truncated fallback charset decoding isolated between responses", async () => {
    const firstResponse = responseFromReader({
      chunks: ["ab😀cd"],
      contentType: "text/plain; charset=x-unsupported-test",
    });
    await expect(readResponseText(firstResponse, { maxBytes: 3 })).resolves.toMatchObject({
      text: "ab",
      truncated: true,
    });

    const secondResponse = responseFromReader({
      chunks: ["cd"],
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
      chunks: ["hel", "lo", ""],
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

  it("treats a native bodyless response as empty when maxBytes is set", async () => {
    await expect(
      readResponseText(new Response(null, { status: 204 }), { maxBytes: 4 }),
    ).resolves.toEqual({
      text: "",
      truncated: false,
      bytesRead: 0,
    });
  });

  it("counts UTF-8 bytes in uncapped native responses", async () => {
    const value = "中文🔥";
    await expect(readResponseText(new Response(value))).resolves.toEqual({
      text: value,
      truncated: false,
      bytesRead: new TextEncoder().encode(value).byteLength,
    });
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
