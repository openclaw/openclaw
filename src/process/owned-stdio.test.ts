import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOwnedStdioProcess, OwnedStdioCleanupError } from "./owned-stdio.js";

const createChild = vi.hoisted(() => vi.fn());
vi.mock("./supervisor/adapters/child.js", () => ({ createChildAdapter: createChild }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  createChild.mockReset();
  vi.useRealTimers();
});

describe("owned stdio startup cleanup", () => {
  it("joins an admitted child's cleanup before reporting the original startup failure", async () => {
    const cleanup = createDeferred();
    const original = new Error("startup failed after admission");
    createChild.mockImplementation(({ onSpawnCleanup }) => {
      onSpawnCleanup(cleanup.promise);
      throw original;
    });
    const rejected = vi.fn();
    const starting = createOwnedStdioProcess({ argv: ["server"] }).catch((error: unknown) => {
      rejected(error);
      return error;
    });
    await Promise.resolve();
    expect(rejected).not.toHaveBeenCalled();
    cleanup.resolve();
    expect(await starting).toBe(original);
  });

  it("preserves the original startup failure when loaded cleanup settles after 500ms", async () => {
    const original = new Error("startup failed after admission");
    createChild.mockImplementation(({ onSpawnCleanup }) => {
      onSpawnCleanup(
        new Promise<void>((resolve) => {
          setTimeout(resolve, 750);
        }),
      );
      throw original;
    });

    const starting = createOwnedStdioProcess({ argv: ["server"] });
    const rejected = expect(starting).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(750);
    await rejected;
  });

  it.each(["rejected", "unsettled"])(
    "reports %s constructor cleanup as uncertainty rather than an ordinary spawn error",
    async (outcome) => {
      const cleanup = createDeferred();
      const original = new Error("startup failed after admission");
      createChild.mockImplementation(({ onSpawnCleanup }) => {
        onSpawnCleanup(cleanup.promise);
        if (outcome === "rejected") {
          cleanup.reject(new Error("owner lost"));
        }
        throw original;
      });
      try {
        const starting = createOwnedStdioProcess({ argv: ["server"] }).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        if (outcome === "unsettled") {
          await vi.advanceTimersByTimeAsync(5_000);
        }
        const error = await starting;
        expect(error).toBeInstanceOf(OwnedStdioCleanupError);
        // The startup failure leads; cleanup uncertainty and the next step follow it.
        expect((error as Error).message).toMatch(
          /^startup failed after admission; stdio startup cleanup also did not confirm closure, so restart the Gateway before retrying$/,
        );
        expect(((error as Error).cause as AggregateError).errors).toEqual([
          original,
          expect.objectContaining({
            message: outcome === "rejected" ? "owner lost" : expect.stringContaining("within 5s"),
          }),
        ]);
      } finally {
        cleanup.resolve();
      }
    },
  );
});
