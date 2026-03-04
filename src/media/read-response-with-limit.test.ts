import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: loggerMocks.warn,
  }),
}));

const { readResponseWithLimit } = await import("./read-response-with-limit.js");

function makeReader(params: {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?: () => Promise<void>;
  releaseLock?: () => void;
}) {
  return {
    read: vi.fn(params.read),
    cancel: vi.fn(params.cancel ?? (async () => {})),
    releaseLock: vi.fn(params.releaseLock ?? (() => {})),
  };
}

describe("readResponseWithLimit", () => {
  beforeEach(() => {
    loggerMocks.warn.mockClear();
  });

  it("warns when cancel fails after overflow", async () => {
    const cancelError = new Error("cancel failed");
    const reader = makeReader({
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([4]) }),
      cancel: vi.fn(async () => {
        throw cancelError;
      }),
    });
    const response = {
      body: { getReader: () => reader },
      url: "https://example.com/media.bin",
    } as unknown as Response;

    await expect(readResponseWithLimit(response, 3)).rejects.toThrow(
      "Content too large: 4 bytes (limit: 3 bytes)",
    );

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith("response stream reader cancel failed", {
      error: "Error: cancel failed",
      maxBytes: 3,
      url: "https://example.com/media.bin",
    });
  });

  it("warns when releaseLock fails but still returns buffer", async () => {
    const releaseError = new Error("release failed");
    const reader = makeReader({
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce({ done: true }),
      releaseLock: vi.fn(() => {
        throw releaseError;
      }),
    });
    const response = {
      body: { getReader: () => reader },
      url: "https://example.com/media.bin",
    } as unknown as Response;

    const result = await readResponseWithLimit(response, 10);

    expect(result.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(loggerMocks.warn).toHaveBeenCalledWith("response stream reader releaseLock failed", {
      error: "Error: release failed",
      maxBytes: 10,
      url: "https://example.com/media.bin",
    });
  });
});
