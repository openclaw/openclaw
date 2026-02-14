import { describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.fn();

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

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

    const { fetchWithGuard } = await import("./input-files.js");
    await expect(
      fetchWithGuard({
        url: "https://example.com/file.bin",
        maxBytes: 6,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow("Content too large");

    // Allow cancel() microtask to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("base64 size guards", () => {
  it("rejects oversized base64 images before decoding", async () => {
    const data = Buffer.alloc(7).toString("base64");
    const { extractImageContentFromSource } = await import("./input-files.js");
    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(
      extractImageContentFromSource(
        { type: "base64", data, mediaType: "image/png" },
        {
          allowUrl: false,
          allowedMimes: new Set(["image/png"]),
          maxBytes: 6,
          maxRedirects: 0,
          timeoutMs: 1,
        },
      ),
    ).rejects.toThrow("Image too large");

    // Regression check: the oversize reject must happen before Buffer.from(..., "base64") allocates.
    const base64Calls = fromSpy.mock.calls.filter((args) => args[1] === "base64");
    expect(base64Calls).toHaveLength(0);
    fromSpy.mockRestore();
  });

  it("rejects oversized base64 files before decoding", async () => {
    const data = Buffer.alloc(7).toString("base64");
    const { extractFileContentFromSource } = await import("./input-files.js");
    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(
      extractFileContentFromSource({
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
      }),
    ).rejects.toThrow("File too large");

    const base64Calls = fromSpy.mock.calls.filter((args) => args[1] === "base64");
    expect(base64Calls).toHaveLength(0);
    fromSpy.mockRestore();
  });
});
