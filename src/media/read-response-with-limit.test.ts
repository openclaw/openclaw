import { describe, expect, it, vi } from "vitest";
import * as logger from "../logger.js";
import { readResponseWithLimit } from "./read-response-with-limit.js";

describe("readResponseWithLimit", () => {
  it("rejects from content-length header before opening the stream", async () => {
    let getReaderCalls = 0;
    const res = {
      headers: {
        get(name: string) {
          return name.toLowerCase() === "content-length" ? "10" : null;
        },
      },
      body: {
        getReader() {
          getReaderCalls += 1;
          throw new Error("should not get here");
        },
      },
    } as unknown as Response;

    await expect(readResponseWithLimit(res, 4)).rejects.toThrow("10 bytes");
    expect(getReaderCalls).toBe(0);
  });

  it("ignores invalid content-length values and reads the body", async () => {
    const res = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-length": "not-a-number" },
    });

    const out = await readResponseWithLimit(res, 10);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it("logs cleanup failures instead of swallowing them silently", async () => {
    const debugSpy = vi.spyOn(logger, "logDebug").mockImplementation(() => {});

    const reader = {
      read: vi.fn(async () => ({ done: false as const, value: new Uint8Array([1, 2, 3, 4, 5]) })),
      cancel: vi.fn(async () => {
        throw new Error("cancel boom");
      }),
      releaseLock: vi.fn(() => {
        throw new Error("release boom");
      }),
    };

    const res = {
      headers: { get: () => null },
      body: {
        getReader: () => reader,
      },
    } as unknown as Response;

    await expect(
      readResponseWithLimit(res, 4, {
        onOverflow: () => new Error("overflow"),
      }),
    ).rejects.toThrow("overflow");

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to cancel stream after overflow"),
    );
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("failed to release reader lock"));
    debugSpy.mockRestore();
  });
});
