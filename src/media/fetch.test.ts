import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  withStrictGuardedFetchMode: <T>(params: T) => params,
}));

type FetchRemoteMedia = typeof import("./fetch.js").fetchRemoteMedia;
type LookupFn = NonNullable<Parameters<FetchRemoteMedia>[0]["lookupFn"]>;
let fetchRemoteMedia: FetchRemoteMedia;

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

function makeLookupFn(): LookupFn {
  return vi.fn(async () => ({ address: "149.154.167.220", family: 4 })) as unknown as LookupFn;
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

  beforeAll(async () => {
    vi.resetModules();
    ({ fetchRemoteMedia } = await import("./fetch.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    fetchWithSsrFGuardMock.mockReset().mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        url: string;
        fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        init?: RequestInit;
      };
      if (params.url.startsWith("http://127.0.0.1/")) {
        throw new Error("Blocked hostname or private/internal/special-use IP address");
      }
      const fetcher = params.fetchImpl ?? globalThis.fetch;
      if (!fetcher) {
        throw new Error("fetch is not available");
      }
      return {
        response: await fetcher(params.url, params.init),
        finalUrl: params.url,
        release: async () => {},
      };
    });
  });

  it("rejects when content-length exceeds maxBytes", async () => {
    const lookupFn = vi.fn(async () => ({
      address: "93.184.216.34",
      family: 4,
    })) as unknown as LookupFn;
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
    const lookupFn = vi.fn(async () => ({
      address: "93.184.216.34",
      family: 4,
    })) as unknown as LookupFn;
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
    vi.useFakeTimers();
    try {
      const lookupFn = vi.fn(async () => ({
        address: "93.184.216.34",
        family: 4,
      })) as unknown as LookupFn;
      const fetchImpl = makeStallingFetch(new Uint8Array([1, 2]));
      const fetchPromise = fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn,
        maxBytes: 1024,
        readIdleTimeoutMs: 20,
      });
      const rejection = expect(fetchPromise).rejects.toMatchObject({
        code: "fetch_failed",
        name: "MediaFetchError",
      });

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
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

  it("bounds error-body snippets instead of reading the full response", async () => {
    const hiddenTail = `${" ".repeat(9_000)}BAD`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new TextEncoder().encode(hiddenTail)]), {
          status: 400,
          statusText: "Bad Request",
        }),
    );

    const result = await fetchRemoteMedia({
      url: "https://example.com/file.bin",
      fetchImpl,
      maxBytes: 1024,
    }).catch((err: unknown) => err);

    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect.unreachable("expected fetchRemoteMedia to reject");
    }
    expect(result.message).not.toContain("BAD");
    expect(result.message).not.toContain("body:");
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
