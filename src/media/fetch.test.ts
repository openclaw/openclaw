import { describe, expect, it } from "vitest";

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
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });
});
