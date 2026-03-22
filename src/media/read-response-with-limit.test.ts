import { beforeEach, describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

function makeStream(chunks: Uint8Array[], delayMs?: number) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeStallingStream(initialChunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of initialChunks) {
        controller.enqueue(chunk);
      }
    },
  });
}

describe("readResponseWithLimit", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reads all chunks within the limit", async () => {
    const body = makeStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    const res = new Response(body);
    const buf = await readResponseWithLimit(res, 100);
    expect(buf).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("throws when total exceeds maxBytes", async () => {
    const body = makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
    const res = new Response(body);
    await expect(readResponseWithLimit(res, 4)).rejects.toThrow(/too large/i);
  });

  it("calls custom onOverflow", async () => {
    const body = makeStream([new Uint8Array(10)]);
    const res = new Response(body);
    await expect(
      readResponseWithLimit(res, 5, {
        onOverflow: ({ size, maxBytes }) => new Error(`custom: ${size} > ${maxBytes}`),
      }),
    ).rejects.toThrow("custom: 10 > 5");
  });

  it("times out when no new chunk arrives before idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const body = makeStallingStream([new Uint8Array([1, 2])]);
      const res = new Response(body);
      const readPromise = readResponseWithLimit(res, 1024, { chunkTimeoutMs: 50 });
      const rejection = expect(readPromise).rejects.toThrow(/stalled/i);
      await vi.advanceTimersByTimeAsync(60);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  it("does not time out while chunks keep arriving", async () => {
    vi.useFakeTimers();
    try {
      const body = makeStream([new Uint8Array([1]), new Uint8Array([2])], 10);
      const res = new Response(body);
      const readPromise = readResponseWithLimit(res, 100, { chunkTimeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(25);
      const buf = await readPromise;
      expect(buf).toEqual(Buffer.from([1, 2]));
    } finally {
      vi.useRealTimers();
    }
  });
});
