import { describe, expect, it, vi } from "vitest";
import { fetchRemoteMedia } from "./fetch.js";

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

describe("fetchRemoteMedia", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;

  it("rejects when content-length exceeds maxBytes", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
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
    ]) as unknown as LookupFn;
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

  it("sanitizes Windows-style traversal segments in content-disposition filename", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response(Buffer.from("%PDF-1.4"), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="..\\\\..\\\\secret.pdf"',
        },
      });

    const result = await fetchRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn,
    });

    expect(result.fileName).toBe("secret.pdf");
  });

  it("sanitizes RFC5987 filename* values with encoded Windows separators", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response(Buffer.from("%PDF-1.4"), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename*=UTF-8''..%5C..%5Creport-final.pdf",
        },
      });

    const result = await fetchRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn,
    });

    expect(result.fileName).toBe("report-final.pdf");
  });

  it("preserves quoted-pair escapes in quoted filename values", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response(Buffer.from("%PDF-1.4"), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="foo\\\"bar.txt"',
        },
      });

    const result = await fetchRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn,
    });

    expect(result.fileName).toBe('foo"bar.txt');
  });

  it("preserves literal escaped backslash before a quote in quoted filename values", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response(Buffer.from("%PDF-1.4"), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": String.raw`attachment; filename="foo\\\"bar.txt"`,
        },
      });

    const result = await fetchRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn,
    });

    expect(result.fileName).toBe(String.raw`foo\"bar.txt`);
  });
});
