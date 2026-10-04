import "../test-utils/prepare-compiled-subprocesses.js";
// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import {
  installMediaFetchTestHooks,
  readRemoteMediaBuffer,
  saveRemoteMedia,
  saveResponseMedia,
  tempHome,
  makeStream,
  makeStreamResponse,
  makeResponseFetch,
  makeCancelableStream,
  makeLookupFn,
} from "./fetch.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { hasErrnoCode } from "../infra/errors.js";

describe("readRemoteMediaBuffer", () => {
  installMediaFetchTestHooks();

  it("streams successful responses directly into the media store", async () => {
    const fetchImpl = makeResponseFetch([new Uint8Array([1, 2, 3]), new Uint8Array([4])], {
      "content-disposition": 'attachment; filename="photo"',
      "content-type": "image/png",
    });

    const saved = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("photo");
    expect(saved.contentType).toBe("image/png");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.png$/);
    expect(saved.path).not.toMatch(/photo---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("preserves content-disposition CSV detection for streamed downloads", async () => {
    const csv = Buffer.from("name,value\nopenclaw,1\n");
    const fetchImpl = makeResponseFetch([csv.subarray(0, 8), csv.subarray(8)], {
      "content-disposition": 'attachment; filename="report.csv"',
      "content-type": "application/octet-stream",
    });

    const saved = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 64,
    });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe("text/csv");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.csv$/);
    expect(saved.path).not.toMatch(/report---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(csv);
  });

  it("preserves content-disposition CSV detection for provided response streams", async () => {
    const csv = Buffer.from("name,value\nopenclaw,1\n");
    const response = new Response(makeStream([csv.subarray(0, 8), csv.subarray(8)]), {
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="report.csv"',
        "content-type": "application/octet-stream",
      },
    });

    const saved = await saveResponseMedia(response, {
      sourceUrl: "https://example.com/download",
      maxBytes: 64,
    });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe("text/csv");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.csv$/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(csv);
  });

  it("preserves content-disposition CSV detection for buffered downloads", async () => {
    const csv = Buffer.from("name,value\nopenclaw,1\n");
    const fetchImpl = makeResponseFetch([csv.subarray(0, 8), csv.subarray(8)], {
      "content-disposition": 'attachment; filename="report.csv"',
      "content-type": "application/octet-stream",
    });

    const media = await readRemoteMediaBuffer({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 64,
    });

    expect(media.fileName).toBe("report.csv");
    expect(media.contentType).toBe("text/csv");
    expect(media.buffer).toStrictEqual(csv);
  });

  it("keeps explicit stream detection hints ahead of content-disposition filenames", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], {
        "content-disposition": 'attachment; filename="report.csv"',
        "content-type": "application/octet-stream",
      }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.docx$/);
    expect(saved.path).not.toMatch(/\.csv$/);
  });

  it("keeps byte-sniffed images ahead of content-disposition stream hints", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const fetchImpl = makeResponseFetch([jpeg], {
      "content-disposition": 'attachment; filename="report.csv"',
      "content-type": "application/octet-stream",
    });

    const saved = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe("image/jpeg");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.jpg$/);
    expect(saved.path).not.toMatch(/\.csv$/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(jpeg);
  });

  it("keeps saving a healthy streaming body after the response-header deadline", async () => {
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
          { status: 200, headers: { "content-type": "application/octet-stream" } },
        );
      });
      const result = saveRemoteMedia({
        url: "https://example.com/download",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 8,
        responseHeaderTimeoutMs: 10,
        readIdleTimeoutMs: 30,
      });

      await vi.advanceTimersByTimeAsync(80);

      const saved = await result;
      await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the parent abort active while saving the response body", async () => {
    const parent = new AbortController();
    let bodyStarted!: () => void;
    const bodyReady = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
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
            bodyStarted();
          },
        }),
        { status: 200 },
      );
    });
    const result = saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      requestInit: { signal: parent.signal },
      lookupFn: makeLookupFn(),
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

  it("clamps oversized saved-response idle timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const fetchImpl = vi.fn(async () =>
        makeStreamResponse([1, 2, 3], { "content-type": "application/octet-stream" }),
      );

      const saved = await saveRemoteMedia({
        url: "https://example.com/download",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 8,
        readIdleTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      });

      await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2, 3]));
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
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

  it("decodes URL path basenames when deriving remote media filenames", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], { "content-type": "application/pdf" }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/files/My%20Report.pdf",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("My Report.pdf");
  });

  it("keeps raw URL path basenames when percent escapes are malformed", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], { "content-type": "application/pdf" }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/files/bad%E0%A4%A.pdf",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("bad%E0%A4%A.pdf");
  });

  it.each([
    ["https://example.com/files/reports%5CQ1.pdf", "reports_Q1.pdf"],
    ["https://example.com/files/reports%2F%2FQ1.pdf", "reports__Q1.pdf"],
  ])(
    "keeps decoded URL fallback separators inside the selected basename",
    async (url, fileName) => {
      const fetchImpl = vi.fn(async () =>
        makeStreamResponse([1, 2, 3], { "content-type": "application/pdf" }),
      );

      const saved = await saveRemoteMedia({
        url,
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 8,
      });

      expect(saved.fileName).toBe(fileName);
    },
  );

  it.each([
    {
      name: "quoted filename containing a semicolon",
      header: 'attachment; filename="quarter;final.csv"',
      fileName: "quarter;final.csv",
    },
    {
      name: "quoted filename containing an escaped quotation mark",
      header: String.raw`attachment; filename="quarter\"final.csv"`,
      fileName: 'quarter"final.csv',
    },
    {
      name: "quoted filename containing multiple escaped punctuation characters",
      header: String.raw`attachment; filename="quarter\ final\,v2.csv"`,
      fileName: "quarter final,v2.csv",
    },
    {
      name: "filename text inside an unrelated quoted parameter is ignored",
      header: 'attachment; note="x; filename=spoof.csv; y"; filename=safe.csv',
      fileName: "safe.csv",
    },
    {
      name: "Windows drive paths still decode escaped punctuation",
      header: String.raw`attachment; filename="C:/tmp/quarter\;final.csv"`,
      fileName: "quarter;final.csv",
    },
    {
      name: "mixed Windows path separators preserve the final basename",
      header: String.raw`attachment; filename="C:/tmp/reports\Q1.csv"`,
      fileName: "Q1.csv",
    },
    {
      name: "legacy UNC Windows path preserves a Unicode-leading basename",
      header: String.raw`attachment; filename="\\server\share\é.csv"`,
      fileName: "é.csv",
    },
    {
      name: "legacy UNC Windows path preserves a punctuation-leading basename",
      header: String.raw`attachment; filename="\\server\share\;photo.csv"`,
      fileName: ";photo.csv",
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
      name: "valid extended filename preferred over plain fallback",
      header: "attachment; filename=legacy.csv; filename*=UTF-8'en'%E2%82%ACrates.csv",
      fileName: "€rates.csv",
    },
    {
      name: "malformed extended filename falls back to plain filename",
      header: "attachment; filename=fallback.csv; filename*=UTF-8''%ZZbad.csv",
      fileName: "fallback.csv",
    },
    {
      name: "unusable extended filename dot before plain",
      header: "attachment; filename*=UTF-8''.; filename=fallback.csv",
      fileName: "fallback.csv",
    },
    {
      name: "unusable extended filename encoded parent after plain",
      header: "attachment; filename=fallback.csv; filename*=UTF-8''%2E%2E",
      fileName: "fallback.csv",
    },
    {
      name: "unsupported extended charset falls back to plain filename",
      header: "attachment; filename*=UTF-16''bad.csv; filename=fallback.csv",
      fileName: "fallback.csv",
    },
  ] as const)("parses $name for buffered and stored remote media", async (testCase) => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], {
        "content-disposition": testCase.header,
        "content-type": "text/csv",
      }),
    );
    const request = {
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    };

    const buffered = await readRemoteMediaBuffer(request);
    const stored = await saveRemoteMedia(request);

    expect(buffered.fileName).toBe(testCase.fileName);
    expect(stored.fileName).toBe(testCase.fileName);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [`attachment; filename*=UTF-8''reports%5CQ1.pdf`, "reports_Q1.pdf"],
    [`attachment; filename*=UTF-8''reports%2F%2FQ1.pdf`, "reports__Q1.pdf"],
  ])(
    "keeps decoded content-disposition filename* separators inside the selected filename",
    async (contentDisposition, fileName) => {
      const fetchImpl = vi.fn(async () =>
        makeStreamResponse([1, 2, 3], {
          "content-disposition": contentDisposition,
          "content-type": "application/pdf",
        }),
      );

      const saved = await saveRemoteMedia({
        url: "https://example.com/download",
        fetchImpl,
        lookupFn: makeLookupFn(),
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

  it("uses caller filename hints for MIME detection without preserving storage basenames", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], { "content-type": "application/octet-stream" }),
    );

    const saved = await saveRemoteMedia({
      url: "https://smba.trafficmanager.net/v3/attachments/att-1/views/original",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document.docx");
    expect(saved.contentType).toBe(contentType);
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.docx$/);
    expect(saved.path).not.toMatch(/document---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2, 3]));
  });

  it("normalizes Windows-style response filenames and caller hints on POSIX hosts", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3], {
        "content-disposition": String.raw`attachment; filename="C:\Users\Ada\Downloads\photo.png"`,
        "content-type": "application/octet-stream",
      }),
    );

    const savedFromHeader = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(savedFromHeader.fileName).toBe("photo.png");

    const savedFromHint = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl: vi.fn(async () =>
        makeStreamResponse([1, 2, 3], { "content-type": "application/octet-stream" }),
      ),
      lookupFn: makeLookupFn(),
      filePathHint: String.raw`C:\Users\Ada\Downloads\document.docx`,
      maxBytes: 8,
    });

    expect(savedFromHint.fileName).toBe("document.docx");
    expect(savedFromHint.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("does not let filename hints force stored extensions before byte sniffing", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const fetchImpl = makeResponseFetch([jpeg], { "content-type": "application/octet-stream" });

    const saved = await saveRemoteMedia({
      url: "https://example.com/views/original",
      fetchImpl,
      lookupFn: makeLookupFn(),
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

    const saved = await saveRemoteMedia({
      url: "https://smba.trafficmanager.net/v3/attachments/att-1/views/original",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document.docx",
      fallbackContentType: contentType,
      originalFilename: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document.docx");
    expect(saved.contentType).toBe(contentType);
    expect(saved.path).toMatch(/document---.+\.docx$/);
  });

  it("uses fallback content type when streamed response headers are generic", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([4, 5, 6], { "content-type": "application/octet-stream" }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/views/original",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document",
      fallbackContentType: contentType,
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document");
    expect(saved.contentType).toBe(contentType);
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.docx$/);
    expect(saved.path).not.toMatch(/document---/);
  });

  it("uses audio fallback content type when streamed response headers report matching video container", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([7, 8, 9], { "content-type": "video/mp4" }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/voice.mp4",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "voice.mp4",
      fallbackContentType: "audio/mp4",
      maxBytes: 8,
    });

    expect(saved.contentType).toBe("audio/mp4");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.m4a$/);
  });

  it("cancels streamed response bodies when media save exceeds maxBytes", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.enqueue(new Uint8Array([4, 5, 6]));
            },
            cancel,
          }),
          { status: 200 },
        ),
    );

    await expect(
      saveRemoteMedia({
        url: "https://example.com/large.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 4,
      }),
    ).rejects.toThrow("exceeds maxBytes");
    expect(cancel).toHaveBeenCalledTimes(1);
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
      const operation = saveRemoteMedia({
        url: "https://example.com/large.bin",
        fetchImpl: async () => response,
        lookupFn: makeLookupFn(),
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

    const saved = await saveRemoteMedia({
      url: "https://example.com/retry.png",
      fetchImpl,
      beforeRequest,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0, onRetry },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(saved.contentType).toBe("image/png");
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([5, 6]));
  });

  it("does not retry permanent media limit failures", async () => {
    const fetchImpl = vi.fn(async () =>
      makeStreamResponse([1, 2, 3, 4, 5], { "content-length": "5" }),
    );

    await expect(
      saveRemoteMedia({
        url: "https://example.com/too-large.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 4,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow("exceeds maxBytes");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
