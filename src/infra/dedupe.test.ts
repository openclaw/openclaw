import { describe, expect, it } from "vitest";
import { createDedupeCache } from "./dedupe.js";

describe("createDedupeCache", () => {
  it("returns false for first check", () => {
    const cache = createDedupeCache({ ttlMs: 1000, maxSize: 100 });
    expect(cache.check("key1")).toBe(false);
  });
});
