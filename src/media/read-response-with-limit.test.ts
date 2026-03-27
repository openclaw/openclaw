import { beforeEach, describe, expect, it, vi } from "vitest";
import { readResponseTextSnippet, readResponseWithLimit } from "./read-response-with-limit.js";

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

  it("uses a custom idle-timeout error when provided", async () => {
    vi.useFakeTimers();
    try {
      const body = makeStallingStream([new Uint8Array([1, 2])]);
      const res = new Response(body);
      const readPromise = readResponseWithLimit(res, 1024, {
        chunkTimeoutMs: 50,
        onIdleTimeout: ({ chunkTimeoutMs }) => new Error(`custom idle ${chunkTimeoutMs}`),
      });
      const rejection = expect(readPromise).rejects.toThrow("custom idle 50");
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

describe("readResponseTextSnippet", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns collapsed text within the limit", async () => {
    const res = new Response(makeStream([new TextEncoder().encode("hello   \n world")]));
    await expect(readResponseTextSnippet(res, { maxBytes: 64, maxChars: 50 })).resolves.toBe(
      "hello world",
    );
  });

  it("truncates to the byte limit without reading the full body", async () => {
    const res = new Response(
      makeStream([new TextEncoder().encode("12345"), new TextEncoder().encode("67890")]),
    );
    await expect(readResponseTextSnippet(res, { maxBytes: 7, maxChars: 50 })).resolves.toBe(
      "1234567…",
    );
  });

  it("applies the idle timeout while reading snippets", async () => {
    vi.useFakeTimers();
    try {
      const res = new Response(makeStallingStream([new Uint8Array([65, 66])]));
      const readPromise = readResponseTextSnippet(res, { maxBytes: 64, chunkTimeoutMs: 50 });
      const rejection = expect(readPromise).rejects.toThrow(/stalled/i);
      await vi.advanceTimersByTimeAsync(60);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);
});
