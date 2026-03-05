import { describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

type MockReader = {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
};

function makeResponse(reader: MockReader): Response {
  return {
    body: {
      getReader: () => reader,
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

describe("readResponseWithLimit", () => {
  it("concatenates streamed chunks without per-chunk Buffer.from conversions", async () => {
    const reader: MockReader = {
      read: vi
        .fn<MockReader["read"]>()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([3, 4]) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn<MockReader["cancel"]>().mockResolvedValue(undefined),
      releaseLock: vi.fn<MockReader["releaseLock"]>(),
    };

    const fromSpy = vi.spyOn(Buffer, "from");
    const buffer = await readResponseWithLimit(makeResponse(reader), 16);

    expect(Array.from(buffer)).toEqual([1, 2, 3, 4]);
    expect(fromSpy).toHaveBeenCalledTimes(0);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);

    fromSpy.mockRestore();
  });

  it("cancels stream and throws when payload exceeds maxBytes", async () => {
    const reader: MockReader = {
      read: vi
        .fn<MockReader["read"]>()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([4]) }),
      cancel: vi.fn<MockReader["cancel"]>().mockResolvedValue(undefined),
      releaseLock: vi.fn<MockReader["releaseLock"]>(),
    };

    await expect(readResponseWithLimit(makeResponse(reader), 3)).rejects.toThrow(
      "Content too large",
    );

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("still throws overflow when cancel/releaseLock fail", async () => {
    const reader: MockReader = {
      read: vi
        .fn<MockReader["read"]>()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([3]) }),
      cancel: vi.fn<MockReader["cancel"]>().mockRejectedValue(new Error("cancel failed")),
      releaseLock: vi.fn<MockReader["releaseLock"]>().mockImplementation(() => {
        throw new Error("release failed");
      }),
    };

    await expect(readResponseWithLimit(makeResponse(reader), 2)).rejects.toThrow(
      "Content too large",
    );

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("falls back to arrayBuffer when reader is unavailable", async () => {
    const res = {
      body: null,
      arrayBuffer: vi.fn(async () => Uint8Array.from([9, 8, 7]).buffer),
    } as unknown as Response;

    const buffer = await readResponseWithLimit(res, 3);
    expect(buffer).toEqual(Buffer.from([9, 8, 7]));

    await expect(readResponseWithLimit(res, 2)).rejects.toThrow("Content too large");
  });
});
