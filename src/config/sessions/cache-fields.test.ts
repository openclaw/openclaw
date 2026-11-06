// Session cache field tests cover cached metadata stored with sessions.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

describe("SessionEntry cache fields", () => {
  const existing: SessionEntry = {
    sessionId: "test-session",
    updatedAt: 1,
    cacheRead: 1000,
    cacheWrite: 200,
    totalTokens: 5000,
  };

  it("merges cache fields properly", () => {
    const merged = mergeSessionEntry(existing, {
      cacheRead: 1500,
      cacheWrite: 300,
    });

    expect(merged.cacheRead).toBe(1500);
    expect(merged.cacheWrite).toBe(300);
    expect(merged.totalTokens).toBe(5000);
  });

  it("allows cache fields to be cleared with undefined", () => {
    const merged = mergeSessionEntry(existing, {
      cacheRead: undefined,
      cacheWrite: undefined,
    });

    expect(merged.cacheRead).toBeUndefined();
    expect(merged.cacheWrite).toBeUndefined();
  });
});
