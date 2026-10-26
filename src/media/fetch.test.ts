import "../test-utils/prepare-compiled-subprocesses.js";
// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import {
  installMediaFetchTestHooks,
  fetchWithSsrFGuardMock,
  readRemoteMediaBuffer,
  saveRemoteMedia,
  saveResponseMedia,
  tempHome,
  makeStreamResponse,
  makeResponseFetch,
  makeCancelableStream,
  makeLookupFn,
} from "./fetch.test-support.js";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { hasErrnoCode } from "../infra/errors.js";
import { makeStallingStream } from "../infra/http-body.test-support.js";

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

function mediaRequest(overrides: Partial<Parameters<typeof saveRemoteMedia>[0]> = {}) {
  return {
    url: "https://example.com/file.bin",
    lookupFn: makeLookupFn(),
    maxBytes: 1024,
    ...overrides,
  };
}

const readMedia = (options: Partial<Parameters<typeof readRemoteMediaBuffer>[0]>) =>
  readRemoteMediaBuffer(mediaRequest(options));
const saveMedia = (options: Partial<Parameters<typeof saveRemoteMedia>[0]>) =>
  saveRemoteMedia(mediaRequest(options));

function abortableBodyFetch(onStart: () => void = () => {}, progressing = false) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
          if (progressing) {
            setTimeout(() => controller.enqueue(new Uint8Array([1])), 25);
            setTimeout(() => controller.enqueue(new Uint8Array([2])), 50);
            setTimeout(() => {
              signal?.removeEventListener("abort", failForAbort);
              controller.close();
            }, 75);
          } else {
            controller.enqueue(new Uint8Array([1]));
          }
          onStart();
        },
      }),
      { status: 200 },
    );
  });
}

describe("readRemoteMediaBuffer", () => {
  const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
  const redactedBotToken = `${botToken.slice(0, 6)}…${botToken.slice(-4)}`;
  const botFileUrl = `https://files.example.test/file/bot${botToken}/photos/1.jpg`;
  installMediaFetchTestHooks();

  it("rejects when streamed payload exceeds maxBytes", async () => {
    const fetchImpl = makeResponseFetch([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
    await expect(readMedia({ fetchImpl, maxBytes: 4 })).rejects.toThrow("exceeds maxBytes");
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
    const error = await readMedia({
      url: botFileUrl,
      fetchImpl,
      ssrfPolicy: { allowedHostnames: ["files.example.test"], allowRfc2544BenchmarkRange: true },
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(botToken);
    expect(String(error)).toBe(expectedErrorText);
  });

  it("uses the default response-header deadline for stalled media", async () => {
    vi.useFakeTimers();
    try {
      const result = readMedia({ fetchImpl: makeResponseHeaderStallingFetch() }).catch(
        (error: unknown) => error,
      );

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
      const fetchImpl = abortableBodyFetch(undefined, true);

      const result = readMedia({ fetchImpl, responseHeaderTimeoutMs: 10, readIdleTimeoutMs: 30 });

      await vi.advanceTimersByTimeAsync(80);

      await expect(result).resolves.toMatchObject({ buffer: Buffer.from([1, 2]) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the parent abort active while reading the response body", async () => {
    const parent = new AbortController();
    const fetchImpl = abortableBodyFetch();
    const result = readMedia({
      fetchImpl,
      requestInit: { signal: parent.signal },
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

  it("retries a default response-body idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(makeStallingStream([new Uint8Array([1, 2])]), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const result = readMedia({
        fetchImpl,
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

  it.each([
    [
      "4xx responses",
      () => Promise.resolve(new Response("missing", { status: 404 })),
      { code: "http_error", status: 404 },
    ],
    [
      "caller aborts",
      () =>
        Promise.reject(
          Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
        ),
      { code: "fetch_failed" },
    ],
    [
      "maxBytes failures",
      () =>
        Promise.resolve(new Response("large", { status: 200, headers: { "content-length": "5" } })),
      { code: "max_bytes" },
    ],
  ] as const)("does not retry %s", async (_name, firstResponse, expected) => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(firstResponse)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await expect(
      readRemoteMediaBuffer(
        mediaRequest({
          fetchImpl,
          maxBytes: expected.code === "max_bytes" ? 4 : 1024,
          retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        }),
      ),
    ).rejects.toMatchObject(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels retry backoff for store writes", async () => {
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
      const operation = saveRemoteMedia({
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

    await readMedia({ fetchImpl, requestInit: { signal: parent.signal }, timeoutMs: 1234 });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(requireFetchGuardRequest()).toMatchObject({
      url: "https://example.com/file.bin",
      timeoutMs: 1234,
      signal: parent.signal,
    });
  });

  it("passes the HTTPS-only redirect policy through the guarded fetch path", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

    await readMedia({
      url: "https://example.com/favicon.ico",
      fetchImpl,
      requireHttps: true,
      maxBytes: undefined,
    });

    expect(requireFetchGuardRequest()).toMatchObject({
      url: "https://example.com/favicon.ico",
      requireHttps: true,
    });
  });

  it("preserves content-disposition CSV detection for streamed downloads", async () => {
    const csv = Buffer.from("name,value\nopenclaw,1\n");
    const fetchImpl = makeResponseFetch([csv.subarray(0, 8), csv.subarray(8)], {
      "content-disposition": 'attachment; filename="report.csv"',
      "content-type": "application/octet-stream",
    });

    const saved = await saveMedia({ url: "https://example.com/download", fetchImpl, maxBytes: 64 });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe("text/csv");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.csv$/);
    expect(saved.path).not.toMatch(/report---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(csv);
  });

  it("retains the HTTP charset when staging remote text", async () => {
    const bytes = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0x88]);
    const saved = await saveMedia({
      url: "https://example.com/download",
      fetchImpl: makeResponseFetch([bytes], {
        "content-disposition": 'attachment; filename="notes.txt"',
        "content-type": 'application/x-openclaw-charset-proof; charset="cp1251"',
      }),
      maxBytes: 64,
    });

    expect(saved.contentType).toBe("application/x-openclaw-charset-proof;charset=cp1251");
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(bytes);
  });

  it("keeps the parent abort active while saving the response body", async () => {
    const parent = new AbortController();
    const { promise: bodyReady, resolve: bodyStarted } = createDeferred();
    const fetchImpl = abortableBodyFetch(bodyStarted);
    const result = saveMedia({
      url: "https://example.com/download",
      fetchImpl,
      requestInit: { signal: parent.signal },
      maxBytes: 8,
      responseHeaderTimeoutMs: 60_000,
    }).catch((error: unknown) => error);

    await bodyReady;
    parent.abort();

    await expect(result).resolves.toMatchObject({
      name: "MediaFetchError",
      code: "fetch_failed",
      cause: { name: "AbortError" },
    });
  });

  it.each([
    ["5", "content length 5 exceeds maxBytes 4", true],
    ["1e9", "invalid content-length header: 1e9", false],
  ] as const)(
    "cancels saved-response content-length %s (%s; partially read: %s)",
    async (contentLength, message, partiallyRead) => {
      const body = makeCancelableStream([new Uint8Array([1]), new Uint8Array([2, 3, 4, 5])]);
      const response = new Response(body.stream, {
        status: 200,
        headers: { "content-length": contentLength },
      });
      try {
        if (partiallyRead) {
          const reader = body.stream.getReader();
          try {
            expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1]) });
          } finally {
            reader.releaseLock();
          }
        }
        expect(response.bodyUsed).toBe(partiallyRead);
        await expect(
          saveResponseMedia(response, {
            maxBytes: 4,
            sourceUrl: "https://example.com/file.bin",
          }),
        ).rejects.toThrow(message);
        expect(body.wasCanceled()).toBe(true);
        expect(body.stream.locked).toBe(false);
      } finally {
        await body.stream.cancel();
      }
    },
  );

  it("keeps raw URL path basenames when percent escapes are malformed", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], { "content-type": "application/pdf" }),
    );

    const saved = await saveMedia({
      url: "https://example.com/files/bad%E0%A4%A.pdf",
      fetchImpl,
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("bad%E0%A4%A.pdf");
  });

  it.each([["https://example.com/files/reports%5CQ1.pdf", "reports_Q1.pdf"]])(
    "keeps decoded URL fallback separators inside the selected basename",
    async (url, fileName) => {
      const fetchImpl = vi.fn(async () =>
        makeStreamResponse([1, 2, 3], { "content-type": "application/pdf" }),
      );

      const saved = await saveMedia({ url, fetchImpl, maxBytes: 8 });

      expect(saved.fileName).toBe(fileName);
    },
  );

  it.each([
    {
      name: "unquoted filename retains its leading apostrophe",
      header: "attachment; filename='report.csv",
      fileName: "'report.csv",
    },
    {
      name: "unquoted filename retains its trailing apostrophe",
      header: "attachment; filename=report.csv'",
      fileName: "report.csv'",
    },
    {
      name: "unquoted filename retains surrounding apostrophes",
      header: "attachment; filename='report.csv'",
      fileName: "'report.csv'",
    },
    {
      name: "filename text inside an unrelated quoted parameter is ignored",
      header: 'attachment; note="x; filename=spoof.csv; y"; filename=safe.csv',
      fileName: "safe.csv",
    },
    {
      name: "mixed Windows path separators preserve the final basename",
      header: String.raw`attachment; filename="C:/tmp/reports\Q1.csv"`,
      fileName: "Q1.csv",
    },
    {
      name: "legacy relative Windows path is reduced to its basename",
      header: String.raw`attachment; filename="reports\Q1.csv"`,
      fileName: "Q1.csv",
    },
    {
      name: "ISO-8859-1 extended filename",
      header: "attachment; filename*=ISO-8859-1''caf%E9.csv",
      fileName: "café.csv",
    },
    {
      name: "malformed extended filename falls back to plain filename",
      header: "attachment; filename=fallback.csv; filename*=UTF-8''%ZZbad.csv",
      fileName: "fallback.csv",
    },
    {
      name: "unsupported extended charset falls back to plain filename",
      header: "attachment; filename*=UTF-16''bad.csv; filename=fallback.csv",
      fileName: "fallback.csv",
    },
  ] as const)("parses $name for buffered remote media", async (testCase) => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], {
        "content-disposition": testCase.header,
        "content-type": "text/csv",
      }),
    );
    const buffered = await readMedia({
      url: "https://example.com/download",
      fetchImpl,
      maxBytes: 8,
    });

    expect(buffered.fileName).toBe(testCase.fileName);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([[`attachment; filename*=UTF-8''reports%2F%2FQ1.pdf`, "reports__Q1.pdf"]])(
    "keeps decoded content-disposition filename* separators inside the selected filename",
    async (contentDisposition, fileName) => {
      const fetchImpl = vi.fn(async () =>
        makeStreamResponse([1, 2, 3], {
          "content-disposition": contentDisposition,
          "content-type": "application/pdf",
        }),
      );

      const saved = await saveMedia({
        url: "https://example.com/download",
        fetchImpl,
        maxBytes: 8,
      });

      expect(saved.fileName).toBe(fileName);
    },
  );

  it("rejects bodyless successful responses without saving an empty file", async () => {
    const inboundDir = path.join(tempHome.home, ".openclaw", "media", "inbound");
    const listInboundFiles = async () => {
      try {
        return (await fs.readdir(inboundDir)).toSorted();
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      }
    };
    const before = await listInboundFiles();

    await expect(
      saveResponseMedia(new Response(null, { status: 204 }), {
        sourceUrl: "https://example.com/empty",
        fallbackContentType: "application/octet-stream",
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({
      name: "MediaFetchError",
      code: "http_error",
      status: 204,
      message:
        "Failed to fetch media from https://example.com/empty: HTTP 204; empty response body",
    });
    await expect(listInboundFiles()).resolves.toEqual(before);
  });

  it("does not let filename hints force stored extensions before byte sniffing", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const fetchImpl = makeResponseFetch([jpeg], { "content-type": "application/octet-stream" });

    const saved = await saveMedia({
      url: "https://example.com/views/original",
      fetchImpl,
      filePathHint: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document.docx");
    expect(saved.contentType).toBe("image/jpeg");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.jpg$/);
    expect(saved.path).not.toMatch(/\.docx$/);
    expect(saved.path).not.toMatch(/document---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(jpeg);
  });

  it("preserves explicit original filenames when saving streams", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], { "content-type": "application/octet-stream" }),
    );

    const saved = await saveMedia({
      url: "https://smba.trafficmanager.net/v3/attachments/att-1/views/original",
      fetchImpl,
      filePathHint: "document.docx",
      fallbackContentType: contentType,
      originalFilename: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document.docx");
    expect(saved.contentType).toBe(contentType);
    expect(saved.path).toMatch(/document---.+\.docx$/);
  });

  it("uses audio fallback content type when streamed response headers report matching video container", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([7, 8, 9], { "content-type": "video/mp4" }),
    );

    const saved = await saveMedia({
      url: "https://example.com/voice.mp4",
      fetchImpl,
      filePathHint: "voice.mp4",
      fallbackContentType: "audio/mp4",
      maxBytes: 8,
    });

    expect(saved.contentType).toBe("audio/mp4");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.m4a$/);
  });

  it.each(["streamed", "content-length"])(
    "cleans up %s media overflow before a response clone is released",
    async (kind) => {
      const body = makeCancelableStream([new Uint8Array([1, 2, 3, 4, 5])]);
      const response = new Response(body.stream, {
        headers: kind === "content-length" ? { "content-length": "5" } : {},
      });
      const capture = response.clone();
      const subdir = `captured-${kind}`;
      let completed = false;
      const operation = saveMedia({
        url: "https://example.com/large.bin",
        fetchImpl: async () => response,
        maxBytes: 4,
        subdir,
      })
        .catch((error: unknown) => error)
        .finally(() => {
          completed = true;
        });
      try {
        await vi.waitFor(() => expect(completed).toBe(true), { timeout: 500 });
        await expect(operation).resolves.toMatchObject({ code: "max_bytes" });
        expect(response.body?.locked).toBe(false);
        expect(body.wasCanceled()).toBe(false);
        const dir = path.join(tempHome.home, ".openclaw", "media", subdir);
        await expect(
          fs.readdir(dir).catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return [];
            }
            throw error;
          }),
        ).resolves.toEqual([]);
      } finally {
        await capture.body?.cancel();
        await operation;
      }
      expect(body.wasCanceled()).toBe(true);
    },
  );

  it("retries saveRemoteMedia after a transient fetch failure", async () => {
    const transientError = Object.assign(new TypeError("socket reset"), { code: "ECONNRESET" });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(makeStreamResponse([5, 6], { "content-type": "image/png" }));
    const onRetry = vi.fn();
    const beforeRequest = vi.fn();

    const saved = await saveMedia({
      url: "https://example.com/retry.png",
      fetchImpl,
      beforeRequest,
      maxBytes: 8,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0, onRetry },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(saved.contentType).toBe("image/png");
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([5, 6]));
  });
});
