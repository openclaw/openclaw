import { describe, expect, it } from "vitest";
import { runAbortableDelivery } from "./abortable-delivery.js";

describe("runAbortableDelivery", () => {
  it("aborts a pending delivery once the abort condition flips", async () => {
    let shouldAbort = false;
    let observedAbort = false;

    const resultPromise = runAbortableDelivery({
      shouldAbort: () => shouldAbort,
      pollMs: 10,
      run: async (abortSignal) => {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    setTimeout(() => {
      shouldAbort = true;
    }, 20);

    await expect(resultPromise).resolves.toEqual({ completed: false });
    expect(observedAbort).toBe(true);
  });

  it("returns the run result when no abort condition is triggered", async () => {
    await expect(
      runAbortableDelivery({
        shouldAbort: () => false,
        run: async () => "ok",
      }),
    ).resolves.toEqual({ completed: true, result: "ok" });
  });
});
