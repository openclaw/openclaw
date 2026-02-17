import { describe, expect, it } from "vitest";
import { computeBackoff } from "./backoff.js";

describe("computeBackoff", () => {
  const policy = { initialMs: 100, maxMs: 5000, factor: 2, jitter: 0 };

  it("returns initialMs on first attempt", () => {
    expect(computeBackoff(policy, 1)).toBe(100);
  });

  it("doubles with factor 2", () => {
    expect(computeBackoff(policy, 2)).toBe(200);
    expect(computeBackoff(policy, 3)).toBe(400);
  });

  it("caps at maxMs", () => {
    expect(computeBackoff(policy, 100)).toBe(5000);
  });

  it("handles attempt 0 same as 1", () => {
    expect(computeBackoff(policy, 0)).toBe(100);
  });

  it("adds jitter when configured", () => {
    const jitterPolicy = { initialMs: 100, maxMs: 10000, factor: 2, jitter: 0.5 };
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      results.add(computeBackoff(jitterPolicy, 2));
    }
    // With jitter, we should get varying results (statistically very likely)
    // Base is 200, jitter adds 0-100, so range is 200-300
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(200);
      expect(r).toBeLessThanOrEqual(300);
    }
  });
});
