import { describe, expect, it } from "vitest";
import { normalizeSecretInputString } from "./types.secrets.js";

describe("normalizeSecretInputString — smart-quote sanitization", () => {
  it("passes through clean ASCII keys unchanged", () => {
    expect(normalizeSecretInputString("sk-abc123-XYZ")).toBe("sk-abc123-XYZ");
  });

  it("trims whitespace", () => {
    expect(normalizeSecretInputString("  sk-abc  ")).toBe("sk-abc");
  });

  it("replaces smart/curly quotes with straight quotes", () => {
    expect(normalizeSecretInputString("\u2018key\u2019")).toBe("'key'");
    expect(normalizeSecretInputString("\u201Ckey\u201D")).toBe('"key"');
  });

  it("replaces em/en dashes with hyphens", () => {
    expect(normalizeSecretInputString("sk\u2014abc\u2013def")).toBe("sk-abc-def");
  });

  it("removes BOM and non-breaking spaces", () => {
    expect(normalizeSecretInputString("\uFEFFsk\u00a0abc")).toBe("sk abc");
  });

  it("strips non-ASCII characters that would break HTTP headers", () => {
    // em dash (U+2014) → "-", then any remaining non-ASCII stripped
    expect(normalizeSecretInputString("sk-abc\u00e9")).toBe("sk-abc");
  });

  it("returns undefined for empty/whitespace-only strings", () => {
    expect(normalizeSecretInputString("")).toBeUndefined();
    expect(normalizeSecretInputString("   ")).toBeUndefined();
  });

  it("returns undefined for non-string values", () => {
    expect(normalizeSecretInputString(undefined)).toBeUndefined();
    expect(normalizeSecretInputString(42)).toBeUndefined();
    expect(normalizeSecretInputString(null)).toBeUndefined();
  });
});
