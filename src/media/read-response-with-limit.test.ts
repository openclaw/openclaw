import { describe, expect, it, vi } from "vitest";
import { readResponseWithLimit } from "./read-response-with-limit.js";

type MockReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
};

function makeResponseWithReader(reader: MockReader): Response {
  return {
    body: {
      getReader: () => reader,
    },
    arrayBuffer: async () => new Uint8Array().buffer,
    url: "https://example.com/file.bin",
  } as unknown as Response;
}

describe("readResponseWithLimit", () => {
  it("reports reader cancel failures through onReaderCleanupError while preserving overflow errors", async () => {
    let readCount = 0;
    const cancelError = new Error("cancel failed");
    const onReaderCleanupError = vi.fn();
    const reader: MockReader = {
      async read() {
        readCount += 1;
        if (readCount === 1) {
          return { done: false, value: new Uint8Array([1, 2]) };
        }
        if (readCount === 2) {
          return { done: false, value: new Uint8Array([3, 4]) };
        }
        return { done: true };
      },
      async cancel() {
        throw cancelError;
      },
      releaseLock() {},
    };
    const res = makeResponseWithReader(reader);

    await expect(
      readResponseWithLimit(res, 3, {
        onReaderCleanupError,
      }),
    ).rejects.toThrow("Content too large");

    expect(onReaderCleanupError).toHaveBeenCalledTimes(1);
    const [params] = onReaderCleanupError.mock.calls[0] as [
      { phase: string; error: unknown; res: Response },
    ];
    expect(params.phase).toBe("cancel");
    expect(params.error).toBe(cancelError);
    expect(params.res).toBe(res);
  });

  it("reports releaseLock failures through onReaderCleanupError without failing successful reads", async () => {
    let done = false;
    const releaseError = new Error("release failed");
    const onReaderCleanupError = vi.fn();
    const reader: MockReader = {
      async read() {
        if (done) {
          return { done: true };
        }
        done = true;
        return { done: false, value: new Uint8Array([9, 8, 7]) };
      },
      async cancel() {},
      releaseLock() {
        throw releaseError;
      },
    };
    const res = makeResponseWithReader(reader);

    await expect(
      readResponseWithLimit(res, 10, {
        onReaderCleanupError,
      }),
    ).resolves.toEqual(Buffer.from([9, 8, 7]));

    expect(onReaderCleanupError).toHaveBeenCalledTimes(1);
    const [params] = onReaderCleanupError.mock.calls[0] as [
      { phase: string; error: unknown; res: Response },
    ];
    expect(params.phase).toBe("release-lock");
    expect(params.error).toBe(releaseError);
    expect(params.res).toBe(res);
  });
});
