import { describe, expect, it } from "vitest";
import { installUiPolyfills } from "../ui/src/ui/polyfills.ts";

describe("control-ui toSorted polyfill", () => {
  it("adds Array.prototype.toSorted when missing", () => {
    const arrayPrototype = Array.prototype as unknown as { toSorted?: unknown };
    const original = arrayPrototype.toSorted;
    delete arrayPrototype.toSorted;

    try {
      installUiPolyfills();
      const installed = arrayPrototype.toSorted as
        | ((this: number[], compareFn?: (a: number, b: number) => number) => number[])
        | undefined;
      expect(typeof installed).toBe("function");
      const originalValues = [3, 1, 2];
      const sorted = installed?.call(originalValues, (a, b) => a - b);
      expect(sorted).toEqual([1, 2, 3]);
      expect(originalValues).toEqual([3, 1, 2]);
    } finally {
      if (original) {
        arrayPrototype.toSorted = original;
      } else {
        delete arrayPrototype.toSorted;
      }
    }
  });
});
