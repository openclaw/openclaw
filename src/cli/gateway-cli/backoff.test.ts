// src/cli/gateway-cli/backoff.test.ts
import { describe, it, expect } from "vitest";
import { calculateBackoffMs, applyJitter } from "./backoff.js";

describe("calculateBackoffMs", () => {
  it("returns 0 for zero consecutive failures", () => {
    expect(calculateBackoffMs(0)).toBe(0);
  });

  it("returns 2000ms for first failure", () => {
    expect(calculateBackoffMs(1)).toBe(2000);
  });

  it("returns 4000ms for second failure", () => {
    expect(calculateBackoffMs(2)).toBe(4000);
  });

  it("returns 32000ms for fifth failure", () => {
    expect(calculateBackoffMs(5)).toBe(32000);
  });

  it("caps at 60000ms for high failure counts", () => {
    expect(calculateBackoffMs(10)).toBe(60000);
    expect(calculateBackoffMs(100)).toBe(60000);
  });
});

describe("applyJitter", () => {
  it("returns 0 for 0 input", () => {
    expect(applyJitter(0)).toBe(0);
  });

  it("returns value within +/- 10% of input", () => {
    const input = 10000;
    const minExpected = Math.floor(input * 0.9);
    const maxExpected = Math.ceil(input * 1.1);
    for (let i = 0; i < 100; i++) {
      const result = applyJitter(input);
      expect(result).toBeGreaterThanOrEqual(minExpected);
      expect(result).toBeLessThanOrEqual(maxExpected);
    }
  });

  it("returns an integer", () => {
    const result = applyJitter(2000);
    expect(Number.isInteger(result)).toBe(true);
  });
});
