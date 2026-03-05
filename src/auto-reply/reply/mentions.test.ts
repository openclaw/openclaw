import { describe, expect, it } from "vitest";
import { stripStructuralPrefixes } from "./mentions.js";

describe("stripStructuralPrefixes", () => {
  it("returns empty string for undefined input at runtime", () => {
    expect(stripStructuralPrefixes(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips sender prefix labels", () => {
    expect(stripStructuralPrefixes("John: hello")).toBe("hello");
  });

  it("passes through plain text", () => {
    expect(stripStructuralPrefixes("just a message")).toBe("just a message");
  });
});
