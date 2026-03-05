import { describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

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

describe("readResponseWithLimit", () => {
  it("concatenates streamed chunks under limit", async () => {
    const res = new Response(
      makeStream([new TextEncoder().encode("hello "), new TextEncoder().encode("world")]),
    );

    const out = await readResponseWithLimit(res, 32);
    expect(out.toString("utf8")).toBe("hello world");
  });

  it("cancels the reader and surfaces custom overflow errors", async () => {
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn(() => {});
    const read = vi
      .fn<() => Promise<{ done: boolean; value?: Uint8Array }>>()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([4, 5, 6]) });

    const reader = { read, cancel, releaseLock };
    const res = {
      body: { getReader: () => reader },
    } as unknown as Response;

    const onOverflow = vi.fn(
      ({ size, maxBytes }: { size: number; maxBytes: number }) =>
        new Error(`too-big ${size}/${maxBytes}`),
    );

    await expect(readResponseWithLimit(res, 4, { onOverflow })).rejects.toThrow("too-big 6/4");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith(expect.objectContaining({ size: 6, maxBytes: 4, res }));
  });

  it("uses arrayBuffer fallback when no stream reader is available", async () => {
    const arr = Uint8Array.from([7, 8, 9]);
    const res = {
      body: null,
      arrayBuffer: vi.fn(async () => arr.buffer),
    } as unknown as Response;

    const out = await readResponseWithLimit(res, 3);
    expect(out).toEqual(Buffer.from([7, 8, 9]));
  });
});
