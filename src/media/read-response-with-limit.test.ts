import { describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

describe("readResponseWithLimit", () => {
  it("concatenates streamed Uint8Array chunks with non-zero offsets", async () => {
    const backing = new Uint8Array([0, 65, 66, 67, 0, 68, 69, 70, 0]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(backing.subarray(1, 4));
        controller.enqueue(backing.subarray(5, 8));
        controller.close();
      },
    });

    const buffer = await readResponseWithLimit(new Response(stream), 16);
    expect(buffer).toEqual(Buffer.from("ABCDEF"));
  });

  it("calls onOverflow and cancels the reader when maxBytes is exceeded", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        canceled = true;
      },
    });
    const res = new Response(stream);
    const overflowError = new Error("custom overflow");
    const onOverflow = vi.fn(() => overflowError);

    await expect(readResponseWithLimit(res, 4, { onOverflow })).rejects.toBe(overflowError);

    expect(onOverflow).toHaveBeenCalledWith(expect.objectContaining({ size: 6, maxBytes: 4, res }));
    expect(canceled).toBe(true);
  });
});
