import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { rethrowAfterMediaCleanup } from "./media-generation-error.js";

describe("media failure cleanup", () => {
  it.each([new Error("generation failed"), undefined, null, false, 0, ""])(
    "retains the original rejection after successful cleanup (%j)",
    async (error) => {
      const cleanup = vi.fn(async () => {});
      await expect(rethrowAfterMediaCleanup(error, cleanup, "unused")).rejects.toBe(error);
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );

  it.each([new Error("cleanup failed"), undefined, null, false, 0, ""])(
    "retains both failures, their order, cause, and the caller message (%j)",
    async (cleanupError) => {
      const error = new Error("generation failed");
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve deliberate primitive cleanup rejections, including undefined.
      const cleanup = vi.fn(() => Promise.reject(cleanupError));
      const failure = await rethrowAfterMediaCleanup(
        error,
        cleanup,
        "Music preflight and cleanup failed",
      ).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        message: "Music preflight and cleanup failed",
        cause: error,
        errors: [error, cleanupError],
      });
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );

  it("handles synchronous cleanup throws without losing an undefined original rejection", async () => {
    const cleanupError = new Error("synchronous cleanup failed");
    await expect(
      rethrowAfterMediaCleanup(
        undefined,
        () => {
          throw cleanupError;
        },
        "Image preflight and cleanup failed",
      ),
    ).rejects.toMatchObject({
      cause: undefined,
      errors: [undefined, cleanupError],
    });
  });

  it("does not publish failure before resource cleanup settles", async () => {
    const released = createDeferredCore();
    const error = new Error("generation failed");
    const observed = vi.fn();
    const result = rethrowAfterMediaCleanup(error, () => released.promise, "unused").catch(
      observed,
    );
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    released.resolve();
    await result;
    expect(observed).toHaveBeenCalledExactlyOnceWith(error);
  });
});
