import { describe, expect, it } from "vitest";
import { redactIdentifier, sha256HexPrefix } from "./redact-identifier.js";

describe("sha256HexPrefix", () => {
  it("returns deterministic hex prefix", () => {
    const a = sha256HexPrefix("test");
    const b = sha256HexPrefix("test");
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it("respects custom length", () => {
    expect(sha256HexPrefix("test", 6)).toHaveLength(6);
    expect(sha256HexPrefix("test", 32)).toHaveLength(32);
  });

  it("clamps length to minimum 1", () => {
    expect(sha256HexPrefix("test", 0)).toHaveLength(1);
    expect(sha256HexPrefix("test", -5)).toHaveLength(1);
  });

  it("different inputs give different outputs", () => {
    expect(sha256HexPrefix("hello")).not.toBe(sha256HexPrefix("world"));
  });
});

describe("redactIdentifier", () => {
  it("returns sha256 prefix for non-empty input", () => {
    const result = redactIdentifier("user@example.com");
    expect(result).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it("returns dash for empty/undefined input", () => {
    expect(redactIdentifier(undefined)).toBe("-");
    expect(redactIdentifier("")).toBe("-");
    expect(redactIdentifier("  ")).toBe("-");
  });

  it("is deterministic", () => {
    expect(redactIdentifier("test")).toBe(redactIdentifier("test"));
  });

  it("accepts custom length", () => {
    const result = redactIdentifier("test", { len: 8 });
    expect(result).toMatch(/^sha256:[0-9a-f]{8}$/);
  });
});
