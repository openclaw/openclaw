import { describe, expect, it } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

function makeStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("readResponseWithLimit", () => {
  it("concats streamed chunks within maxBytes", async () => {
    const res = new Response(makeStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]), {
      status: 200,
    });

    const out = await readResponseWithLimit(res, 16);
    expect(out.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it("throws custom overflow error when payload exceeds maxBytes", async () => {
    const res = new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), {
      status: 200,
    });

    await expect(
      readResponseWithLimit(res, 4, {
        onOverflow: ({ size, maxBytes }) => new Error(`overflow:${size}/${maxBytes}`),
      }),
    ).rejects.toThrow("overflow:5/4");
  });
});
