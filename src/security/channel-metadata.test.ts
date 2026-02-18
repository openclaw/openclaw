import { describe, expect, it } from "vitest";
import { buildUntrustedChannelMetadata } from "./channel-metadata.js";

describe("buildUntrustedChannelMetadata", () => {
  it("returns undefined for empty entries", () => {
    const result = buildUntrustedChannelMetadata({
      source: "test",
      label: "Test",
      entries: [],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when all entries are null or empty", () => {
    const result = buildUntrustedChannelMetadata({
      source: "test",
      label: "Test",
      entries: [null, undefined, "", "   "],
    });
    expect(result).toBeUndefined();
  });

  it("wraps valid entries with external content markers", () => {
    const result = buildUntrustedChannelMetadata({
      source: "telegram",
      label: "Group info",
      entries: ["My Group"],
    });
    expect(result).toBeDefined();
    expect(result).toContain("My Group");
    expect(result).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("deduplicates identical entries", () => {
    const result = buildUntrustedChannelMetadata({
      source: "test",
      label: "Label",
      entries: ["foo", "foo", "bar"],
    });
    expect(result).toBeDefined();
    // Should appear only once
    const fooCount = (result!.match(/foo/g) ?? []).length;
    expect(fooCount).toBe(1);
  });

  it("normalizes whitespace in entries", () => {
    const result = buildUntrustedChannelMetadata({
      source: "test",
      label: "Label",
      entries: ["  hello   world  "],
    });
    expect(result).toBeDefined();
    expect(result).toContain("hello world");
  });

  it("truncates without splitting surrogate pairs", () => {
    // Create an entry that would cause truncation at a surrogate pair boundary.
    // 😀 is 2 UTF-16 code units (\uD83D\uDE00).
    const emoji = "😀";
    const filler = "x".repeat(395);
    // Entry: 395 x's + 😀 = 397 chars (UTF-16 length). Max entry is 400.
    // But the overall truncation at 800 chars with header can still cause issues.
    const result = buildUntrustedChannelMetadata({
      source: "test",
      label: "L",
      entries: [`${filler}${emoji}`],
    });
    expect(result).toBeDefined();
    // The result should not contain a lone surrogate (would show as \uFFFD or cause issues).
    // Verify no lone high surrogates exist in the output.
    for (let i = 0; i < result!.length; i++) {
      const code = result!.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate must be followed by a low surrogate
        const next = result!.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
  });

  it("respects custom maxChars", () => {
    const result = buildUntrustedChannelMetadata({
      source: "test",
      label: "Label",
      entries: ["a".repeat(200)],
      maxChars: 100,
    });
    expect(result).toBeDefined();
    // The output includes wrapper overhead, but the inner content should be truncated
    expect(result!.length).toBeLessThan(300);
  });
});
