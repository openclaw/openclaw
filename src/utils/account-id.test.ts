import { describe, expect, it } from "vitest";
import { normalizeAccountId } from "./account-id.js";

describe("normalizeAccountId", () => {
  it("returns the string as-is when already trimmed", () => {
    expect(normalizeAccountId("abc")).toBe("abc");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeAccountId("  abc  ")).toBe("abc");
  });

  it("returns undefined for empty string", () => {
    expect(normalizeAccountId("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeAccountId("   ")).toBeUndefined();
  });

  it("returns undefined when called with no argument", () => {
    expect(normalizeAccountId()).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeAccountId(undefined)).toBeUndefined();
  });
});
