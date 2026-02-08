import { describe, expect, it } from "vitest";
import { sanitizeMimeType } from "./apply.js";

describe("sanitizeMimeType", () => {
  it("returns undefined for falsy input", () => {
    expect(sanitizeMimeType(undefined)).toBeUndefined();
    expect(sanitizeMimeType("")).toBeUndefined();
    expect(sanitizeMimeType("  ")).toBeUndefined();
  });

  it("accepts standard MIME types", () => {
    expect(sanitizeMimeType("text/plain")).toBe("text/plain");
    expect(sanitizeMimeType("text/html")).toBe("text/html");
    expect(sanitizeMimeType("application/json")).toBe("application/json");
    expect(sanitizeMimeType("image/png")).toBe("image/png");
    expect(sanitizeMimeType("application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
  });

  it("lowercases MIME types", () => {
    expect(sanitizeMimeType("Text/HTML")).toBe("text/html");
    expect(sanitizeMimeType("APPLICATION/JSON")).toBe("application/json");
  });

  it("trims whitespace", () => {
    expect(sanitizeMimeType("  text/plain  ")).toBe("text/plain");
  });

  it("rejects fullwidth Unicode homoglyphs via NFKC normalization", () => {
    // Fullwidth characters (U+FF00 range) should be normalized to ASCII
    // before validation. "\uff54\uff45\uff58\uff54" = fullwidth "ｔｅｘｔ"
    const fullwidthText = "\uff54\uff45\uff58\uff54/\uff48\uff54\uff4d\uff4c";
    expect(sanitizeMimeType(fullwidthText)).toBe("text/html");
  });

  it("rejects values with trailing content after the MIME type", () => {
    // The $ anchor should reject input with trailing characters
    expect(sanitizeMimeType("text/html<script>")).toBeUndefined();
    expect(sanitizeMimeType("text/html\x00evil")).toBeUndefined();
  });

  it("rejects completely invalid values", () => {
    expect(sanitizeMimeType("notamimetype")).toBeUndefined();
    expect(sanitizeMimeType("text")).toBeUndefined();
    expect(sanitizeMimeType("/")).toBeUndefined();
    expect(sanitizeMimeType("text/")).toBeUndefined();
    expect(sanitizeMimeType("/html")).toBeUndefined();
  });
});
