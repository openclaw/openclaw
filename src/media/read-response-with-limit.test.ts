import { describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

type ReaderChunk = ReadableStreamReadResult<Uint8Array>;

function createResponseWithReader(reader: {
  read: () => Promise<ReaderChunk>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
}): Response {
  return {
    body: {
      getReader: () => reader,
    },
    headers: new Headers(),
    url: "https://example.com/file.bin",
  } as unknown as Response;
}

describe("readResponseWithLimit internal error hooks", () => {
  it("reports reader.cancel failures during overflow handling", async () => {
    const onInternalError = vi.fn();
    let readCalls = 0;
    const reader = {
      read: vi.fn(async () => {
        readCalls += 1;
        if (readCalls === 1) {
          return { done: false, value: new Uint8Array([1, 2, 3]) };
        }
        return { done: false, value: new Uint8Array([4, 5, 6]) };
      }),
      cancel: vi.fn(async () => {
        throw new Error("cancel failed");
      }),
      releaseLock: vi.fn(() => {}),
    };

    await expect(
      readResponseWithLimit(createResponseWithReader(reader), 5, { onInternalError }),
    ).rejects.toThrow("Content too large");

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(onInternalError).toHaveBeenCalledTimes(1);
    expect(onInternalError.mock.calls[0]?.[0]).toMatchObject({
      phase: "reader.cancel",
      res: expect.objectContaining({ url: "https://example.com/file.bin" }),
    });
  });

  it("reports reader.releaseLock failures after successful reads", async () => {
    const onInternalError = vi.fn();
    const reader = {
      read: vi
        .fn<() => Promise<ReaderChunk>>()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([7, 8]) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(() => {
        throw new Error("release failed");
      }),
    };

    const output = await readResponseWithLimit(createResponseWithReader(reader), 10, {
      onInternalError,
    });

    expect(output).toEqual(Buffer.from([7, 8]));
    expect(onInternalError).toHaveBeenCalledTimes(1);
    expect(onInternalError.mock.calls[0]?.[0]).toMatchObject({
      phase: "reader.releaseLock",
      res: expect.objectContaining({ url: "https://example.com/file.bin" }),
    });
  });
});
