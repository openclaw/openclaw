// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  getUsageCacheDisplayState,
  getUsageCacheState,
  isUsageCacheIncomplete,
} from "./cache-status.ts";

describe("usage cache status", () => {
  it("merges endpoint severity without combining unrelated file counters", () => {
    expect(
      getUsageCacheState(
        { status: "partial", cachedFiles: 1, pendingFiles: 32, staleFiles: 32 },
        { status: "refreshing", cachedFiles: 32, pendingFiles: 1, staleFiles: 1 },
      ),
    ).toBe("refreshing");
    expect(getUsageCacheState(undefined, undefined)).toBeNull();
  });

  it("maps incomplete cache states to active or paused presentation", () => {
    expect(isUsageCacheIncomplete("partial")).toBe(true);
    expect(isUsageCacheIncomplete("fresh")).toBe(false);
    expect(getUsageCacheDisplayState("refreshing", false)).toBe("rebuilding");
    expect(getUsageCacheDisplayState("stale", true)).toBe("paused");
    expect(getUsageCacheDisplayState("fresh", true)).toBe("ready");
  });
});
