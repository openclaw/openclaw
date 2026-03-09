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

function makeAbortableStallingFetch(firstChunk: Uint8Array) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk);
          const abort = () => {
            controller.error(signal?.reason ?? new Error("aborted"));
          };
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        },
      }),
      { status: 200 },
    );
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

  it("aborts stalled body reads when timeoutMs expires", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = makeAbortableStallingFetch(new Uint8Array([1, 2]));

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn,
        maxBytes: 1024,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "fetch_failed",
      name: "MediaFetchError",
    });
  }, 5_000);

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
