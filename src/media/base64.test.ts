import { describe, expect, it } from "vitest";
import { estimateBase64DecodedBytes } from "./base64.js";

describe("estimateBase64DecodedBytes", () => {
  it("returns 0 for empty string", () => {
    expect(estimateBase64DecodedBytes("")).toBe(0);
  });

  it("returns 0 for whitespace-only", () => {
    expect(estimateBase64DecodedBytes("   \n\t  ")).toBe(0);
  });

  it("estimates correctly for unpadded base64", () => {
    // "hello" = "aGVsbG8=" (8 chars, 1 padding) → 5 bytes
    const encoded = Buffer.from("hello").toString("base64");
    const estimated = estimateBase64DecodedBytes(encoded);
    expect(estimated).toBe(5);
  });

  it("estimates correctly with double padding", () => {
    // "hi" = "aGk=" (4 chars, 1 padding) → 2 bytes
    const encoded = Buffer.from("hi").toString("base64");
    expect(estimateBase64DecodedBytes(encoded)).toBe(2);
  });

  it("handles base64 with embedded whitespace", () => {
    const encoded = Buffer.from("hello world").toString("base64");
    const withSpaces = encoded.split("").join(" ");
    const estimated = estimateBase64DecodedBytes(withSpaces);
    // Should still give a reasonable estimate
    expect(estimated).toBeGreaterThan(0);
  });

  it("handles large inputs efficiently", () => {
    const large = "A".repeat(100_000);
    const start = Date.now();
    const result = estimateBase64DecodedBytes(large);
    expect(Date.now() - start).toBeLessThan(100);
    expect(result).toBeGreaterThan(0);
  });
});
