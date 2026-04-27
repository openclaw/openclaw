import { describe, expect, it } from "vitest";
import { sanitizeMimeType } from "./apply.js";

describe("sanitizeMimeType", () => {
  it("returns a clean MIME for a well-formed value", () => {
    expect(sanitizeMimeType("image/png")).toBe("image/png");
    expect(sanitizeMimeType("application/json")).toBe("application/json");
  });

  it("lowercases the result", () => {
    expect(sanitizeMimeType("IMAGE/PNG")).toBe("image/png");
    expect(sanitizeMimeType("Application/JSON")).toBe("application/json");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeMimeType("  image/png  ")).toBe("image/png");
  });

  it("accepts the RFC 9110 ;parameter tail and strips it", () => {
    expect(sanitizeMimeType("text/html; charset=utf-8")).toBe("text/html");
    expect(sanitizeMimeType("application/json;charset=utf-8")).toBe("application/json");
    expect(sanitizeMimeType("multipart/form-data; boundary=xxx")).toBe("multipart/form-data");
  });

  it("rejects values with trailing junk that is not a parameter", () => {
    expect(sanitizeMimeType("image/png<script>alert(1)</script>")).toBeUndefined();
    expect(sanitizeMimeType("image/png\nx-injected: yes")).toBeUndefined();
    expect(sanitizeMimeType("application/json garbage data")).toBeUndefined();
    expect(sanitizeMimeType("image/png/extra")).toBeUndefined();
  });

  it("rejects an embedded newline before the parameter separator", () => {
    expect(sanitizeMimeType("image/png\n;charset=utf-8")).toBeUndefined();
    expect(sanitizeMimeType("image/png \n; charset=utf-8")).toBeUndefined();
  });

  it("rejects a bare or whitespace-only parameter section", () => {
    expect(sanitizeMimeType("image/png;")).toBeUndefined();
    expect(sanitizeMimeType("image/png; ")).toBeUndefined();
    expect(sanitizeMimeType("image/png;\t")).toBeUndefined();
  });

  it("rejects empty, whitespace, or non-string input", () => {
    expect(sanitizeMimeType("")).toBeUndefined();
    expect(sanitizeMimeType("   ")).toBeUndefined();
    expect(sanitizeMimeType(undefined)).toBeUndefined();
  });

  it("rejects values without a subtype", () => {
    expect(sanitizeMimeType("image/")).toBeUndefined();
    expect(sanitizeMimeType("/png")).toBeUndefined();
    expect(sanitizeMimeType("image")).toBeUndefined();
  });
});
