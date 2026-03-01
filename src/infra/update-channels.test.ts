import { describe, expect, it } from "vitest";
import { isBetaTag, isStableTag } from "./update-channels.js";

describe("update-channels tag detection", () => {
  it("recognizes both -beta and .beta formats", () => {
    expect(isBetaTag("v2026.2.24-beta.1")).toBe(true);
    expect(isBetaTag("v2026.2.24.beta.1")).toBe(true);
  });

  it("keeps legacy -x tags stable", () => {
    expect(isBetaTag("v2026.2.24-1")).toBe(false);
    expect(isStableTag("v2026.2.24-1")).toBe(true);
  });

  it("does not false-positive on non-beta words", () => {
    expect(isBetaTag("v2026.2.24-alphabeta.1")).toBe(false);
    expect(isStableTag("v2026.2.24")).toBe(true);
  });
});
