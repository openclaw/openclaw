import { describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

function createResponseFromReader(reader: {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
}): Response {
  return {
    body: {
      getReader: () => reader,
    },
    url: "https://example.com/test.bin",
  } as unknown as Response;
}

describe("readResponseWithLimit", () => {
  it("reports suppressed cleanup errors during overflow handling", async () => {
    let readCount = 0;
    const response = createResponseFromReader({
      async read() {
        readCount += 1;
        if (readCount === 1) {
          return { done: false, value: new Uint8Array([1, 2, 3]) };
        }
        if (readCount === 2) {
          return { done: false, value: new Uint8Array([4, 5]) };
        }
        return { done: true, value: undefined };
      },
      async cancel() {
        throw new Error("cancel failed");
      },
      releaseLock() {
        throw new Error("release failed");
      },
    });
    const suppressed: Array<{ phase: string; message: string }> = [];

    await expect(
      readResponseWithLimit(response, 4, {
        onSuppressedError: ({ phase, error }) => {
          suppressed.push({ phase, message: String(error) });
        },
      }),
    ).rejects.toThrow("Content too large");

    expect(suppressed).toEqual([
      { phase: "cancel_after_overflow", message: "Error: cancel failed" },
      { phase: "release_lock", message: "Error: release failed" },
    ]);
  });

  it("keeps overflow behavior when error reporter throws", async () => {
    let readCount = 0;
    const response = createResponseFromReader({
      async read() {
        readCount += 1;
        if (readCount === 1) {
          return { done: false, value: new Uint8Array([1, 2, 3]) };
        }
        if (readCount === 2) {
          return { done: false, value: new Uint8Array([4, 5]) };
        }
        return { done: true, value: undefined };
      },
      async cancel() {
        throw new Error("cancel failed");
      },
      releaseLock() {
        throw new Error("release failed");
      },
    });
    const onSuppressedError = vi.fn(() => {
      throw new Error("observer failed");
    });

    await expect(
      readResponseWithLimit(response, 4, {
        onSuppressedError,
      }),
    ).rejects.toThrow("Content too large");

    expect(onSuppressedError).toHaveBeenCalledTimes(2);
  });
});
