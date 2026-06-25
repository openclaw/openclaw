// Tests for E.164 phone number normalization.
import { describe, expect, it } from "vitest";
import { normalizeE164 } from "./utils.js";

describe("normalizeE164", () => {
  it("adds + prefix to digits", () => {
    expect(normalizeE164("1234567890")).toBe("+1234567890");
  });

  it("preserves existing + prefix", () => {
    expect(normalizeE164("+1234567890")).toBe("+1234567890");
  });

  it("removes non-digit characters", () => {
    expect(normalizeE164("+1 (234) 567-890")).toBe("+1234567890");
  });

  it("removes protocol prefix", () => {
    expect(normalizeE164("tel:+1234567890")).toBe("+1234567890");
  });

  it("removes protocol prefix with alphanumeric", () => {
    expect(normalizeE164("whatsapp:+1234567890")).toBe("+1234567890");
  });

  it("removes protocol prefix with hyphen", () => {
    expect(normalizeE164("my-service:+1234567890")).toBe("+1234567890");
  });

  it("handles empty string", () => {
    expect(normalizeE164("")).toBe("+");
  });

  it("handles whitespace", () => {
    expect(normalizeE164("  1234567890  ")).toBe("+1234567890");
  });

  it("handles multiple + signs", () => {
    expect(normalizeE164("++1234567890")).toBe("++1234567890");
  });

  it("keeps + in middle", () => {
    expect(normalizeE164("123+4567890")).toBe("+123+4567890");
  });
});
