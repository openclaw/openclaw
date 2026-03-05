import { describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

function makeResponseWithReader(reader: {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
}): Response {
  return {
    body: {
      getReader: () => reader,
    },
    arrayBuffer: async () => new ArrayBuffer(0),
    url: "https://example.com/file.bin",
  } as unknown as Response;
}

describe("readResponseWithLimit", () => {
  it("reports reader.cancel errors through onReaderError during overflow", async () => {
    const cancelError = new Error("cancel failed");
    const reader = {
      read: vi
        .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(async () => {
        throw cancelError;
      }),
      releaseLock: vi.fn(() => undefined),
    };

    const onReaderError = vi.fn();

    await expect(
      readResponseWithLimit(makeResponseWithReader(reader), 2, {
        onOverflow: () => new Error("overflow"),
        onReaderError,
      }),
    ).rejects.toThrow("overflow");

    expect(onReaderError).toHaveBeenCalledWith({ phase: "cancel", error: cancelError });
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("reports reader.releaseLock errors through onReaderError", async () => {
    const releaseError = new Error("release failed");
    const reader = {
      read: vi
        .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(() => {
        throw releaseError;
      }),
    };

    const onReaderError = vi.fn();
    const buffer = await readResponseWithLimit(makeResponseWithReader(reader), 8, {
      onReaderError,
    });

    expect(buffer).toEqual(Buffer.from([1, 2]));
    expect(onReaderError).toHaveBeenCalledWith({ phase: "releaseLock", error: releaseError });
  });
});
