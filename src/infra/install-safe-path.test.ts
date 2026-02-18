import { describe, expect, it } from "vitest";
import { safePathSegmentHashed } from "./install-safe-path.js";

describe("safePathSegmentHashed", () => {
  it("keeps safe names unchanged", () => {
    expect(safePathSegmentHashed("demo-skill")).toBe("demo-skill");
  });

  it("normalizes separators and adds hash suffix", () => {
    const result = safePathSegmentHashed("../../demo/skill");
    expect(result.includes("/")).toBe(false);
    expect(result.includes("\\")).toBe(false);
    expect(result).toMatch(/-[a-f0-9]{10}$/);
  });

  it("hashes long names while staying bounded", () => {
    const long = "a".repeat(100);
    const result = safePathSegmentHashed(long);
    expect(result.length).toBeLessThanOrEqual(61);
    expect(result).toMatch(/-[a-f0-9]{10}$/);
  });
});
