import { describe, expect, it } from "vitest";
import { getFdInfo, type FdInfo } from "./health.js";

describe("getFdInfo", () => {
  it("returns FD info on supported platforms or null gracefully", () => {
    const result = getFdInfo();

    // The function should either return a valid FdInfo or null
    // It should NOT throw
    if (result !== null) {
      expect(typeof result.used).toBe("number");
      expect(result.used).toBeGreaterThanOrEqual(0);
      // limit and percent are optional
      if (result.limit !== undefined) {
        expect(typeof result.limit).toBe("number");
        expect(result.limit).toBeGreaterThan(0);
      }
      if (result.percent !== undefined) {
        expect(typeof result.percent).toBe("number");
        expect(result.percent).toBeGreaterThanOrEqual(0);
        expect(result.percent).toBeLessThanOrEqual(100);
      }
    }
    // If null, that's also acceptable (unsupported platform or sandboxed env)
  });

  it("FdInfo type conforms to expected shape", () => {
    // Type check - this will cause a compile error if the type is wrong
    const fdInfo: FdInfo = { used: 10, limit: 1000, percent: 1 };
    expect(fdInfo.used).toBe(10);
    expect(fdInfo.limit).toBe(1000);
    expect(fdInfo.percent).toBe(1);

    // Optional fields can be omitted
    const fdInfoMinimal: FdInfo = { used: 5 };
    expect(fdInfoMinimal.used).toBe(5);
    expect(fdInfoMinimal.limit).toBeUndefined();
  });
});
