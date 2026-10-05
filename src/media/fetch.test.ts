import "../test-utils/prepare-compiled-subprocesses.js";
// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import {
  installMediaFetchTestHooks,
  type ReadRemoteMediaBuffer,
  fetchWithSsrFGuardMock,
  readRemoteMediaBuffer,
  saveRemoteMedia,
  defaultFetchMediaMaxBytes,
  makeStream,
  makeStreamResponse,
  makeResponseFetch,
  makeCancelableStream,
  makeLookupFn,
} from "./fetch.test-support.js";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

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

function makeResponseHeaderStallingFetch() {
  return vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectForAbort = () => reject(abortReasonError(signal));
        if (signal?.aborted) {
          rejectForAbort();
          return;
        }
        signal?.addEventListener("abort", rejectForAbort, { once: true });
      }),
  );
}

function abortReasonError(signal?: AbortSignal | null): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("request aborted", { cause: signal?.reason });
}

function requireFetchGuardRequest(): unknown {
  const [call] = fetchWithSsrFGuardMock.mock.calls;
  if (!call) {
    throw new Error("expected fetchWithSsrFGuard call");
  }
  return call[0];
}

async function expectRemoteMediaMaxBytesError(params: {
  fetchImpl: Parameters<typeof readRemoteMediaBuffer>[0]["fetchImpl"];
  maxBytes: number;
}) {
  await expect(
    readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl: params.fetchImpl,
      maxBytes: params.maxBytes,
      lookupFn: makeLookupFn(),
    }),
  ).rejects.toThrow("exceeds maxBytes");
}

async function expectRedactedBotTokenFetchError(params: {
  botFileUrl: string;
  botToken: string;
  expectedErrorText: string;
  fetchImpl: Parameters<typeof readRemoteMediaBuffer>[0]["fetchImpl"];
}) {
  const error = await readRemoteMediaBuffer({
    url: params.botFileUrl,
    fetchImpl: params.fetchImpl,
    lookupFn: makeLookupFn(),
    maxBytes: 1024,
    ssrfPolicy: {
      allowedHostnames: ["files.example.test"],
      allowRfc2544BenchmarkRange: true,
    },
  }).catch((err: unknown) => err as Error);

  expect(error).toBeInstanceOf(Error);
  const errorText = error instanceof Error ? String(error) : "";
  expect(errorText).not.toContain(params.botToken);
  expect(errorText).toBe(params.expectedErrorText);
}

describe("readRemoteMediaBuffer", () => {
  const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
  const redactedBotToken = `${botToken.slice(0, 6)}…${botToken.slice(-4)}`;
  const botFileUrl = `https://files.example.test/file/bot${botToken}/photos/1.jpg`;
  installMediaFetchTestHooks();

  it("rejects when streamed payload exceeds maxBytes", async () => {
    const fetchImpl = makeResponseFetch([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
    await expectRemoteMediaMaxBytesError({ fetchImpl, maxBytes: 4 });
  });

  it("cancels ignored content-length overflow bodies for remote buffer reads", async () => {
    const body = makeCancelableStream([new Uint8Array([1, 2, 3, 4, 5])]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(body.stream, {
          status: 200,
          headers: { "content-length": "5" },
        }),
    );

    await expectRemoteMediaMaxBytesError({ fetchImpl, maxBytes: 4 });

    expect(body.wasCanceled()).toBe(true);
  });

  it("rejects malformed content-length before remote buffer reads", async () => {
    const body = makeCancelableStream([new Uint8Array([1, 2, 3, 4, 5])]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(body.stream, {
          status: 200,
          headers: { "content-length": "1e9" },
        }),
    );

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn: makeLookupFn(),
      }),
    ).rejects.toThrow("invalid content-length header: 1e9");

    expect(body.wasCanceled()).toBe(true);
  });

  it("accepts comma-joined identical content-length values", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("hello", {
          status: 200,
          headers: { "content-length": "5, 5" },
        }),
    );

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      maxBytes: 5,
      lookupFn: makeLookupFn(),
    });

    expect(result.buffer.toString()).toBe("hello");
  });

  it("applies a default stream limit when maxBytes is omitted", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1], { "content-length": String(defaultFetchMediaMaxBytes + 1) }),
    );

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
      }),
    ).rejects.toThrow(`exceeds maxBytes ${defaultFetchMediaMaxBytes}`);
  });

  it.each([
    {
      name: "redacts bot tokens from fetch failure messages",
      fetchImpl: vi.fn(async () => {
        throw new Error(`dial failed for ${botFileUrl}`);
      }),
      expectedErrorText: `MediaFetchError: Failed to fetch media from https://files.example.test/file/bot${redactedBotToken}/photos/1.jpg: dial failed for https://files.example.test/file/bot${redactedBotToken}/photos/1.jpg`,
    },
    {
      name: "redacts bot tokens from HTTP error messages",
      fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      expectedErrorText: `MediaFetchError: Failed to fetch media from https://files.example.test/file/bot${redactedBotToken}/photos/1.jpg: HTTP 401; body: unauthorized`,
    },
  ] as const)("$name", async ({ fetchImpl, expectedErrorText }) => {
    await expectRedactedBotTokenFetchError({
      botFileUrl,
      botToken,
      expectedErrorText,
      fetchImpl,
    });
  });

  it("aborts stalled body reads when idle timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl: makeStallingFetch(new Uint8Array([1, 2])),
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        readIdleTimeoutMs: 20,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBeInstanceOf(Error);
      await expect(result).resolves.toMatchObject({
        code: "fetch_failed",
        name: "MediaFetchError",
        cause: expect.objectContaining({ name: "TimeoutError" }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts when response headers exceed their deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = makeResponseHeaderStallingFetch();

      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        responseHeaderTimeoutMs: 20,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toMatchObject({
        name: "MediaFetchError",
        code: "fetch_failed",
        cause: { name: "TimeoutError" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the default response-header deadline for stalled media", async () => {
    vi.useFakeTimers();
    try {
      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl: makeResponseHeaderStallingFetch(),
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(15 * 60_000 + 5);

      await expect(result).resolves.toMatchObject({
        name: "MediaFetchError",
        code: "fetch_failed",
        cause: { name: "TimeoutError" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the response-header deadline while a healthy body keeps progressing", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const failForAbort = () => controller.error(signal?.reason);
              if (signal?.aborted) {
                failForAbort();
                return;
              }
              signal?.addEventListener("abort", failForAbort, { once: true });
              setTimeout(() => controller.enqueue(new Uint8Array([1])), 25);
              setTimeout(() => controller.enqueue(new Uint8Array([2])), 50);
              setTimeout(() => {
                signal?.removeEventListener("abort", failForAbort);
                controller.close();
              }, 75);
            },
          }),
          { status: 200 },
        );
      });

      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        responseHeaderTimeoutMs: 10,
        readIdleTimeoutMs: 30,
      });

      await vi.advanceTimersByTimeAsync(80);

      await expect(result).resolves.toMatchObject({ buffer: Buffer.from([1, 2]) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a parent abort while waiting for response headers", async () => {
    const parent = new AbortController();
    const fetchImpl = makeResponseHeaderStallingFetch();
    const result = readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      requestInit: { signal: parent.signal },
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      responseHeaderTimeoutMs: 60_000,
    }).catch((error: unknown) => error);

    parent.abort();

    await expect(result).resolves.toMatchObject({
      name: "MediaFetchError",
      code: "fetch_failed",
      cause: { name: "AbortError" },
    });
  });

  it("keeps the parent abort active while reading the response body", async () => {
    const parent = new AbortController();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            const failForAbort = () => controller.error(signal?.reason);
            if (signal?.aborted) {
              failForAbort();
              return;
            }
            signal?.addEventListener("abort", failForAbort, { once: true });
          },
        }),
        { status: 200 },
      );
    });
    const result = readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      requestInit: { signal: parent.signal },
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      responseHeaderTimeoutMs: 60_000,
    }).catch((error: unknown) => error);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    parent.abort();

    await expect(result).resolves.toMatchObject({
      name: "MediaFetchError",
      code: "fetch_failed",
      cause: { name: "AbortError" },
    });
  });

  it("retries transient fetch failures when retry is enabled", async () => {
    const transientError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.buffer.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx responses when retry is enabled", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, statusText: "Service Unavailable" }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.buffer.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 408 responses when retry is enabled", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("timeout", { status: 408, statusText: "Request Timeout" }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.buffer.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries transient response body read failures when retry is enabled", async () => {
    const transientError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(transientError);
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.buffer.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a default response-body idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        readIdleTimeoutMs: 20,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toMatchObject({ buffer: Buffer.from("ok") });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry 4xx responses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toMatchObject({ code: "http_error", status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry caller aborts", async () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toMatchObject({ code: "fetch_failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "buffer reads",
      fetchMedia: (options: Parameters<ReadRemoteMediaBuffer>[0]) => readRemoteMediaBuffer(options),
    },
    {
      name: "store writes",
      fetchMedia: (options: Parameters<ReadRemoteMediaBuffer>[0]) => saveRemoteMedia(options),
    },
  ])("cancels retry backoff for $name", async ({ fetchMedia }) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(503).end("busy");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a local media test server address");
      }
      const controller = new AbortController();
      const operation = fetchMedia({
        url: `http://127.0.0.1:${address.port}/retry.bin`,
        requestInit: { signal: controller.signal },
        retry: {
          attempts: 2,
          minDelayMs: 25,
          maxDelayMs: 25,
          jitter: 0,
          onRetry: () => {
            setImmediate(() => controller.abort());
          },
        },
      });

      await expect(operation).rejects.toMatchObject({
        name: "MediaFetchError",
        code: "fetch_failed",
        cause: { name: "AbortError" },
      });
      expect(requests).toBe(1);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not retry SSRF guard blocks", async () => {
    const fetchImpl = vi.fn();

    await expect(
      readRemoteMediaBuffer({
        url: "http://127.0.0.1/secret.jpg",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry maxBytes failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("large", { status: 200, headers: { "content-length": "5" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 4,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toMatchObject({ code: "max_bytes" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds error-body snippets instead of reading the full response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new TextEncoder().encode(`${" ".repeat(9_000)}BAD`)]), {
          status: 400,
          statusText: "Bad Request",
        }),
    );
    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect.unreachable("expected readRemoteMediaBuffer to reject");
    }
    expect(result.message).not.toContain("BAD");
    expect(result.message).not.toContain("body:");
  });

  it("uses trusted explicit-proxy mode when the caller opts in for proxy-side DNS", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const lookupFn = makeLookupFn();
    const dispatcherPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: "http://localhost:8888",
      allowPrivateProxy: true,
    };

    await readRemoteMediaBuffer({
      url: "https://files.example.test/file/bot123/photos/test.jpg",
      fetchImpl,
      lookupFn,
      trustExplicitProxyDns: true,
      dispatcherAttempts: [
        {
          dispatcherPolicy,
        },
      ],
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(requireFetchGuardRequest()).toStrictEqual({
      url: "https://files.example.test/file/bot123/photos/test.jpg",
      fetchImpl,
      init: undefined,
      maxRedirects: undefined,
      policy: undefined,
      lookupFn,
      dispatcherPolicy,
      mode: "trusted_explicit_proxy",
      signal: expect.any(AbortSignal),
    });
  });

  it("passes request timeout through the guarded fetch path", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const parent = new AbortController();

    await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      requestInit: { signal: parent.signal },
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      timeoutMs: 1234,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(requireFetchGuardRequest()).toMatchObject({
      url: "https://example.com/file.bin",
      timeoutMs: 1234,
      signal: parent.signal,
    });
  });

  it("passes the HTTPS-only redirect policy through the guarded fetch path", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

    await readRemoteMediaBuffer({
      url: "https://example.com/favicon.ico",
      fetchImpl,
      lookupFn: makeLookupFn(),
      requireHttps: true,
    });

    expect(requireFetchGuardRequest()).toMatchObject({
      url: "https://example.com/favicon.ico",
      requireHttps: true,
    });
  });
});
