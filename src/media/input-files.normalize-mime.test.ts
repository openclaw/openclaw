import { describe, expect, it } from "vitest";
import { normalizeMimeType } from "./input-files.js";

describe("normalizeMimeType", () => {
  it("returns undefined for falsy input", () => {
    expect(normalizeMimeType(undefined)).toBeUndefined();
    expect(normalizeMimeType("")).toBeUndefined();
  });

  it("normalizes standard MIME types", () => {
    expect(normalizeMimeType("text/plain")).toBe("text/plain");
    expect(normalizeMimeType("Text/HTML")).toBe("text/html");
    expect(normalizeMimeType("APPLICATION/JSON")).toBe("application/json");
  });

  it("strips charset and parameters", () => {
    expect(normalizeMimeType("text/html; charset=utf-8")).toBe("text/html");
    expect(normalizeMimeType("application/json;charset=utf-8")).toBe("application/json");
  });

  it("normalizes fullwidth Unicode characters via NFKC", () => {
    // Fullwidth "ｔｅｘｔ/ｈｔｍｌ" should normalize to "text/html"
    const fullwidth = "\uff54\uff45\uff58\uff54/\uff48\uff54\uff4d\uff4c";
    expect(normalizeMimeType(fullwidth)).toBe("text/html");
  });
});
