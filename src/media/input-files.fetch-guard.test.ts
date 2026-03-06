import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.fn();
const convertHeicToJpegMock = vi.fn();

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("./image-ops.js", () => ({
  convertHeicToJpeg: (...args: unknown[]) => convertHeicToJpegMock(...args),
}));

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

let fetchWithGuard: typeof import("./input-files.js").fetchWithGuard;
let extractImageContentFromSource: typeof import("./input-files.js").extractImageContentFromSource;
let extractFileContentFromSource: typeof import("./input-files.js").extractFileContentFromSource;

beforeAll(async () => {
  ({ fetchWithGuard, extractImageContentFromSource, extractFileContentFromSource } =
    await import("./input-files.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HEIC input image normalization", () => {
  it("converts base64 HEIC images to JPEG before returning them", async () => {
    const normalized = Buffer.from("jpeg-normalized");
    convertHeicToJpegMock.mockResolvedValueOnce(normalized);

    const image = await extractImageContentFromSource(
      {
        type: "base64",
        data: Buffer.from("heic-source").toString("base64"),
        mediaType: "image/heic",
      },
      {
        allowUrl: false,
        allowedMimes: new Set(["image/heic", "image/jpeg"]),
        maxBytes: 1024 * 1024,
        maxRedirects: 0,
        timeoutMs: 1,
      },
    );

    expect(convertHeicToJpegMock).toHaveBeenCalledTimes(1);
    expect(image).toEqual({
      type: "image",
      data: normalized.toString("base64"),
      mimeType: "image/jpeg",
    });
  });

  it("converts URL HEIC images to JPEG before returning them", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(Buffer.from("heic-url-source"), {
        status: 200,
        headers: { "content-type": "image/heic" },
      }),
      release,
      finalUrl: "https://example.com/photo.heic",
    });
    const normalized = Buffer.from("jpeg-url-normalized");
    convertHeicToJpegMock.mockResolvedValueOnce(normalized);

    const image = await extractImageContentFromSource(
      {
        type: "url",
        url: "https://example.com/photo.heic",
      },
      {
        allowUrl: true,
        allowedMimes: new Set(["image/heic", "image/jpeg"]),
        maxBytes: 1024 * 1024,
        maxRedirects: 0,
        timeoutMs: 1000,
      },
    );

    expect(convertHeicToJpegMock).toHaveBeenCalledTimes(1);
    expect(image).toEqual({
      type: "image",
      data: normalized.toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithGuard", () => {
  it("rejects oversized streamed payloads and cancels the stream", async () => {
    let canceled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        }
        // keep stream open; cancel() should stop it once maxBytes exceeded
      },
      cancel() {
        canceled = true;
      },
    });

    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
      release,
      finalUrl: "https://example.com/file.bin",
    });

    await expect(
      fetchWithGuard({
        url: "https://example.com/file.bin",
        maxBytes: 6,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow("Content too large");

    // Allow cancel() microtask to run.
    await waitForMicrotaskTurn();

    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("base64 size guards", () => {
  it.each([
    {
      kind: "images",
      expectedError: "Image too large",
      run: async (data: string) => {
        return await extractImageContentFromSource(
          { type: "base64", data, mediaType: "image/png" },
          {
            allowUrl: false,
            allowedMimes: new Set(["image/png"]),
            maxBytes: 6,
            maxRedirects: 0,
            timeoutMs: 1,
          },
        );
      },
    },
    {
      kind: "files",
      expectedError: "File too large",
      run: async (data: string) => {
        return await extractFileContentFromSource({
          source: { type: "base64", data, mediaType: "text/plain", filename: "x.txt" },
          limits: {
            allowUrl: false,
            allowedMimes: new Set(["text/plain"]),
            maxBytes: 6,
            maxChars: 100,
            maxRedirects: 0,
            timeoutMs: 1,
            pdf: { maxPages: 1, maxPixels: 1, minTextChars: 1 },
          },
        });
      },
    },
  ] as const)("rejects oversized base64 $kind before decoding", async (testCase) => {
    const data = Buffer.alloc(7).toString("base64");
    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(testCase.run(data)).rejects.toThrow(testCase.expectedError);

    // Regression check: oversize reject happens before Buffer.from(..., "base64") allocates.
    const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
    expect(base64Calls).toHaveLength(0);
    fromSpy.mockRestore();
  });
});

describe("input image base64 validation", () => {
  it("rejects malformed base64 payloads", async () => {
    await expect(
      extractImageContentFromSource(
        {
          type: "base64",
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)',
          mediaType: "image/png",
        },
        {
          allowUrl: false,
          allowedMimes: new Set(["image/png"]),
          maxBytes: 1024 * 1024,
          maxRedirects: 0,
          timeoutMs: 1,
        },
      ),
    ).rejects.toThrow("invalid 'data' field");
  });

  it("normalizes whitespace in valid base64 payloads", async () => {
    const image = await extractImageContentFromSource(
      {
        type: "base64",
        data: " aGVs bG8= \n",
        mediaType: "image/png",
      },
      {
        allowUrl: false,
        allowedMimes: new Set(["image/png"]),
        maxBytes: 1024 * 1024,
        maxRedirects: 0,
        timeoutMs: 1,
      },
    );
    expect(image.data).toBe("aGVsbG8=");
  });
});
