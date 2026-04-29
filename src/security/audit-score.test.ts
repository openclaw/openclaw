import { describe, expect, it } from "vitest";
import { calculateSecurityScore } from "./audit.js";

describe("calculateSecurityScore", () => {
  it("returns 100 for zero findings", () => {
    expect(calculateSecurityScore({ critical: 0, warn: 0, info: 0 })).toBe(100);
  });

  it("subtracts 25 for critical findings", () => {
    expect(calculateSecurityScore({ critical: 1, warn: 0, info: 0 })).toBe(75);
    expect(calculateSecurityScore({ critical: 2, warn: 0, info: 0 })).toBe(50);
  });

  it("subtracts 10 for warn findings", () => {
    expect(calculateSecurityScore({ critical: 0, warn: 1, info: 0 })).toBe(90);
    expect(calculateSecurityScore({ critical: 0, warn: 3, info: 0 })).toBe(70);
  });

  it("subtracts 2 for info findings", () => {
    expect(calculateSecurityScore({ critical: 0, warn: 0, info: 1 })).toBe(98);
    expect(calculateSecurityScore({ critical: 0, warn: 0, info: 5 })).toBe(90);
  });

  it("caps the minimum score at 0", () => {
    expect(calculateSecurityScore({ critical: 5, warn: 0, info: 0 })).toBe(0);
    expect(calculateSecurityScore({ critical: 10, warn: 10, info: 10 })).toBe(0);
  });

  it("combines deductions correctly", () => {
    expect(calculateSecurityScore({ critical: 1, warn: 2, info: 5 })).toBe(
      100 - 1 * 25 - 2 * 10 - 5 * 2, // 100 - 25 - 20 - 10 = 45
    );
  });
});
