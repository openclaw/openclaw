import fsSync from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { getProcessStartTime } from "./pid-alive.js";

describe("Android process start times", () => {
  it("reads process start time from Android procfs", () => {
    const readFileSyncSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath) => {
      expect(String(filePath)).toBe("/proc/42/stat");
      return "42 (node) S 1 42 42 0 -1 4194304 12345 0 0 0 100 50 0 0 20 0 8 0 55555" as never;
    });

    withMockedPlatform("android" as NodeJS.Platform, () => {
      expect(getProcessStartTime(42)).toBe(55555);
    });

    expect(readFileSyncSpy).toHaveBeenCalledTimes(1);
  });
});
