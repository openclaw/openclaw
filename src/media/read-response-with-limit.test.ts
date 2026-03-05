import { describe, expect, it } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

describe("readResponseWithLimit", () => {
  it("concatenates streamed chunks in order", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });

    const res = new Response(stream, { status: 200 });
    const output = await readResponseWithLimit(res, 10);

    expect([...output]).toEqual([1, 2, 3, 4, 5]);
  });

  it("cancels the reader when payload exceeds limit", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
      },
      cancel() {
        canceled = true;
      },
    });

    await expect(readResponseWithLimit(new Response(stream, { status: 200 }), 6)).rejects.toThrow(
      "Content too large",
    );

    expect(canceled).toBe(true);
  });
});
