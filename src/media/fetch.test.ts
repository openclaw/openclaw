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
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

  it("rejects when content-length exceeds maxBytes", async () => {
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
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("rejects when streamed payload exceeds maxBytes", async () => {
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]), {
        status: 200,
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("blocks private IP literals before fetch", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchRemoteMedia({
        url: "http://127.0.0.1/secret",
        fetchImpl,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks hosts that resolve to private IPs", async () => {
    const fetchImpl = vi.fn();
    const lookupFn = async () => [{ address: "10.0.0.5", family: 4 }];

    await expect(
      fetchRemoteMedia({
        url: "https://private.test/resource",
        fetchImpl,
        lookupFn,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks redirects to private hosts", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      }),
    );

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/redirect",
        fetchImpl,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows public hosts", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(Buffer.from("hello"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await fetchRemoteMedia({
      url: "https://example.com/file.txt",
      fetchImpl,
      lookupFn: publicLookup,
    });

    expect(result.buffer.toString()).toBe("hello");
  });
});
