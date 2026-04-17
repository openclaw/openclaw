import { describe, expect, it } from "vitest";
import { sanitizeMimeType } from "./apply.js";

describe("sanitizeMimeType", () => {
  it("accepts a plain type/subtype", () => {
    expect(sanitizeMimeType("text/plain")).toBe("text/plain");
    expect(sanitizeMimeType("application/json")).toBe("application/json");
  });

  it("lowercases and trims the input", () => {
    expect(sanitizeMimeType("  Text/Plain  ")).toBe("text/plain");
    expect(sanitizeMimeType("IMAGE/PNG")).toBe("image/png");
  });

  it("strips RFC 7231 parameters while keeping the type/subtype", () => {
    expect(sanitizeMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(sanitizeMimeType("application/json;charset=utf-8")).toBe("application/json");
    expect(sanitizeMimeType("text/plain  ;  boundary=abc")).toBe("text/plain");
  });

  it("rejects inputs with invalid characters after the subtype (regression for #9795)", () => {
    expect(sanitizeMimeType("text/plain<script>alert(1)</script>")).toBeUndefined();
    expect(sanitizeMimeType("text/plain garbage")).toBeUndefined();
    expect(sanitizeMimeType("text/plain\nContent-Type: text/html")).toBeUndefined();
  });

  it("rejects inputs missing a type or subtype", () => {
    expect(sanitizeMimeType("textplain")).toBeUndefined();
    expect(sanitizeMimeType("/plain")).toBeUndefined();
    expect(sanitizeMimeType("text/")).toBeUndefined();
  });

  it("returns undefined for blank or missing input", () => {
    expect(sanitizeMimeType(undefined)).toBeUndefined();
    expect(sanitizeMimeType("")).toBeUndefined();
    expect(sanitizeMimeType("   ")).toBeUndefined();
  });
});
