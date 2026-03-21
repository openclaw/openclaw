import { describe, expect, it, vi } from "vitest";
import {
  fetchRemoteMedia,
  isMediaFetchError,
  MediaFetchError,
  SAFE_MEDIA_FETCH_ERROR_MESSAGE,
} from "./fetch.js";

function makeStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeStallingFetch(firstChunk: Uint8Array) {
  return vi.fn(async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk);
        },
      }),
      { status: 200 },
    );
  });
}

function makeLookupFn() {
  return vi.fn(async () => [{ address: "149.154.167.220", family: 4 }]) as unknown as NonNullable<
    Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]
  >;
}

async function expectRedactedTelegramFetchError(params: {
  telegramFileUrl: string;
  telegramToken: string;
  redactedTelegramToken: string;
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
}) {
  const error = await fetchRemoteMedia({
    url: params.telegramFileUrl,
    fetchImpl: params.fetchImpl,
    lookupFn: makeLookupFn(),
    maxBytes: 1024,
    ssrfPolicy: {
      allowedHostnames: ["api.telegram.org"],
      allowRfc2544BenchmarkRange: true,
    },
  }).catch((err: unknown) => err as Error);

  expect(error).toBeInstanceOf(Error);
  const errorText = error instanceof Error ? String(error) : "";
  expect(errorText).not.toContain(params.telegramToken);
  expect(errorText).toContain(`bot${params.redactedTelegramToken}`);
}

describe("fetchRemoteMedia", () => {
  const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
  const redactedTelegramToken = `${telegramToken.slice(0, 6)}…${telegramToken.slice(-4)}`;
  const telegramFileUrl = `https://api.telegram.org/file/bot${telegramToken}/photos/1.jpg`;

  it("rejects when content-length exceeds maxBytes", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3, 4, 5])]), {
        status: 200,
        headers: { "content-length": "5" },
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("rejects when streamed payload exceeds maxBytes", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]), {
        status: 200,
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("aborts stalled body reads when idle timeout expires", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;
    const fetchImpl = makeStallingFetch(new Uint8Array([1, 2]));

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn,
        maxBytes: 1024,
        readIdleTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "fetch_failed",
      name: "MediaFetchError",
    });
  }, 5_000);

  it("redacts Telegram bot tokens from fetch failure messages", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`dial failed for ${telegramFileUrl}`);
    });

    await expectRedactedTelegramFetchError({
      telegramFileUrl,
      telegramToken,
      redactedTelegramToken,
      fetchImpl,
    });
  });

  it("redacts Telegram bot tokens from HTTP error messages", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));

    await expectRedactedTelegramFetchError({
      telegramFileUrl,
      telegramToken,
      redactedTelegramToken,
      fetchImpl,
    });
  });

  it("blocks private IP literals before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchRemoteMedia({
        url: "http://127.0.0.1/secret.jpg",
        fetchImpl,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("isMediaFetchError", () => {
  it("returns true for a MediaFetchError instance", () => {
    const err = new MediaFetchError(
      "fetch_failed",
      "Failed to fetch media from https://example.com",
    );
    expect(isMediaFetchError(err)).toBe(true);
  });

  it("returns true when MediaFetchError is in the cause chain", () => {
    const cause = new MediaFetchError("http_error", "HTTP 500");
    const wrapper = new Error("loadWebMedia failed", { cause });
    expect(isMediaFetchError(wrapper)).toBe(true);
  });

  it("returns false for a generic Error", () => {
    expect(isMediaFetchError(new Error("something else"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isMediaFetchError(null)).toBe(false);
    expect(isMediaFetchError("string error")).toBe(false);
    expect(isMediaFetchError(undefined)).toBe(false);
  });

  it("detects errors whose message contains MediaFetchError name", () => {
    const err = new Error("MediaFetchError: Failed to fetch media from ...");
    expect(isMediaFetchError(err)).toBe(true);
  });
});

describe("SAFE_MEDIA_FETCH_ERROR_MESSAGE", () => {
  it("does not contain PII patterns", () => {
    expect(SAFE_MEDIA_FETCH_ERROR_MESSAGE).not.toMatch(/@g\.us/);
    expect(SAFE_MEDIA_FETCH_ERROR_MESSAGE).not.toMatch(/\+\d{10,}/);
    expect(SAFE_MEDIA_FETCH_ERROR_MESSAGE).not.toMatch(/\/home\//);
    expect(SAFE_MEDIA_FETCH_ERROR_MESSAGE).toContain("Media failed");
  });
});
