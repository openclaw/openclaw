/**
 * Tests for approval slug normalization.
 */
import { describe, expect, it } from "vitest";
import { normalizeApprovalSlug } from "./approval-slug.js";

describe("shared/approval-slug", () => {
  it("truncates to the default max length", () => {
    expect(normalizeApprovalSlug("1234567890")).toBe("12345678");
  });

  it("uses the configured max length", () => {
    expect(normalizeApprovalSlug("1234567890", 4)).toBe("1234");
  });

  it("does not split surrogate pairs at the default boundary", () => {
    const slug = normalizeApprovalSlug("1234567😀890");
    expect(slug).toBe("1234567");
    expect(() => encodeURIComponent(slug)).not.toThrow();
  });
});
