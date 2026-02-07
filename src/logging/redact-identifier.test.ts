import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { redactIdentifier, sha256HexPrefix } from "./redact-identifier.js";

describe("sha256HexPrefix", () => {
  it("returns a hex string of the requested length", () => {
    const result = sha256HexPrefix("hello", 8);
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it("defaults to 12 characters", () => {
    const result = sha256HexPrefix("hello");
    expect(result).toHaveLength(12);
  });

  it("produces a valid sha256 prefix", () => {
    const fullHash = crypto.createHash("sha256").update("hello").digest("hex");
    expect(sha256HexPrefix("hello", 12)).toBe(fullHash.slice(0, 12));
  });

  it("returns different hashes for different inputs", () => {
    expect(sha256HexPrefix("a")).not.toBe(sha256HexPrefix("b"));
  });

  it("returns the same hash for the same input", () => {
    expect(sha256HexPrefix("test")).toBe(sha256HexPrefix("test"));
  });

  it("clamps len to at least 1", () => {
    const result = sha256HexPrefix("hello", 0);
    expect(result).toHaveLength(1);
  });

  it("clamps negative len to 1", () => {
    const result = sha256HexPrefix("hello", -5);
    expect(result).toHaveLength(1);
  });

  it("floors fractional len values", () => {
    const result = sha256HexPrefix("hello", 5.9);
    expect(result).toHaveLength(5);
  });

  it("falls back to 12 for non-finite len", () => {
    expect(sha256HexPrefix("hello", NaN)).toHaveLength(12);
    expect(sha256HexPrefix("hello", Infinity)).toHaveLength(12);
  });
});

describe("redactIdentifier", () => {
  it("returns a sha256-prefixed redaction", () => {
    const result = redactIdentifier("user@example.com");
    expect(result).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it("returns '-' for undefined input", () => {
    expect(redactIdentifier(undefined)).toBe("-");
  });

  it("returns '-' for empty string", () => {
    expect(redactIdentifier("")).toBe("-");
  });

  it("returns '-' for whitespace-only string", () => {
    expect(redactIdentifier("   ")).toBe("-");
  });

  it("trims whitespace before hashing", () => {
    expect(redactIdentifier("  hello  ")).toBe(redactIdentifier("hello"));
  });

  it("respects custom len option", () => {
    const result = redactIdentifier("user@example.com", { len: 6 });
    expect(result).toMatch(/^sha256:[0-9a-f]{6}$/);
  });

  it("produces consistent output for the same input", () => {
    const a = redactIdentifier("+1234567890");
    const b = redactIdentifier("+1234567890");
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", () => {
    const a = redactIdentifier("alice");
    const b = redactIdentifier("bob");
    expect(a).not.toBe(b);
  });
});
