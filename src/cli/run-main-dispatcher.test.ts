import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted mock for undici so the dynamic import inside closeGlobalFetchDispatcher
// is intercepted before any module code runs.
const undiciMocks = vi.hoisted(() => {
  const closeFn = vi.fn().mockResolvedValue(undefined);
  return { closeFn };
});

vi.mock("undici", () => ({
  getGlobalDispatcher: () => ({ close: undiciMocks.closeFn }),
}));

import { closeGlobalFetchDispatcher } from "./run-main.js";

describe("closeGlobalFetchDispatcher", () => {
  afterEach(() => {
    undiciMocks.closeFn.mockReset();
    undiciMocks.closeFn.mockResolvedValue(undefined);
  });

  it("calls getGlobalDispatcher().close() to release pooled HTTP connections", async () => {
    await closeGlobalFetchDispatcher();

    expect(undiciMocks.closeFn).toHaveBeenCalledOnce();
  });

  it("swallows errors so dispatcher cleanup never surfaces as a CLI failure", async () => {
    undiciMocks.closeFn.mockRejectedValue(new Error("dispatcher already closed"));

    // Must not throw
    await expect(closeGlobalFetchDispatcher()).resolves.toBeUndefined();
  });
});
