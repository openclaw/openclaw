// Covers surrogate-safe truncation in channel-metadata and install-policy.
import { describe, expect, it } from "vitest";
import { buildUntrustedChannelMetadata } from "../../src/security/channel-metadata.js";

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const cu = value.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      if (
        i + 1 >= value.length ||
        !(value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff)
      )
        return true;
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      if (i === 0 || !(value.charCodeAt(i - 1) >= 0xd800 && value.charCodeAt(i - 1) <= 0xdbff))
        return true;
    }
  }
  return false;
}

describe("buildUntrustedChannelMetadata surrogate-safe truncation", () => {
  it("does not split an emoji across the DEFAULT_MAX_ENTRY_CHARS truncation boundary", () => {
    // DEFAULT_MAX_ENTRY_CHARS = 400. truncateText does .slice(0, 397) then appends "...".
    // With emoji at position 396 (a surrogate pair straddling the 397 cut),
    // unsafe .slice(0, 397) captures 396 'a' + high surrogate → lone surrogate.
    // Build an entry exceeding 400 chars to force truncation.
    const label = `${"a".repeat(396)}\u{1F389}${"a".repeat(10)}`; // 396 + 2 + 10 = 408 chars
    const result = buildUntrustedChannelMetadata({
      source: "test",
      label: "Test channel",
      entries: [label],
    });

    expect(result).toBeDefined();
    // Would fail on main's .slice() which leaves a dangling high surrogate.
    expect(hasLoneSurrogate(result!)).toBe(false);
  });

  it("does not produce lone surrogates with multiple truncated entries through the full pipeline", () => {
    // Multiple entries near the entry boundary testing both inner truncation
    // and the combined wrapping path.
    const emojiEntry = `${"a".repeat(396)}\u{1F389}${"a".repeat(5)}`; // 403 chars, triggers entry truncation
    const entries = [
      emojiEntry,
      `${"b".repeat(398)}\u{1F600}${"b".repeat(3)}`, // 403 chars, different emoji at boundary
    ];
    const result = buildUntrustedChannelMetadata({
      source: "discord",
      label: "Channel",
      entries,
    });

    expect(result).toBeDefined();
    expect(hasLoneSurrogate(result!)).toBe(false);
  });

  it("leaves short metadata unchanged", () => {
    const result = buildUntrustedChannelMetadata({
      source: "test",
      label: "Test",
      entries: ["hello", "world"],
    });
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(hasLoneSurrogate(result!)).toBe(false);
  });
});
