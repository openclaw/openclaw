// Session group tests cover grouping and lookup of related sessions.
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { buildGroupDisplayTitle, resolveGroupSessionKey, shortenGroupId } from "./group.js";

describe("resolveGroupSessionKey", () => {
  it("preserves Signal group ids from the originating target", () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const ctx = {
      Provider: "signal",
      ChatType: "group",
      From: "signal:+15551234567",
      OriginatingTo: `signal:group:${mixedGroupId}`,
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toEqual({
      key: `signal:group:${mixedGroupId}`,
      channel: "signal",
      id: mixedGroupId,
      chatType: "group",
    });
  });

  it("keeps non-Signal group ids lowercase", () => {
    const ctx = {
      Provider: "telegram",
      ChatType: "group",
      From: "telegram:1234",
      OriginatingTo: "telegram:group:MiXeDGroup",
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toEqual({
      key: "telegram:group:mixedgroup",
      channel: "telegram",
      id: "mixedgroup",
      chatType: "group",
    });
  });

  it("preserves empty opaque segments in originating group ids", () => {
    const ctx = {
      Provider: "matrix",
      ChatType: "channel",
      From: "matrix:channel:!room:[2001:db8::1]",
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toEqual({
      key: "matrix:channel:!room:[2001:db8::1]",
      channel: "matrix",
      id: "!room:[2001:db8::1]",
      chatType: "channel",
    });
  });

  it("rejects empty structural group-route segments", () => {
    const ctx = {
      Provider: "telegram",
      ChatType: "group",
      From: "telegram::group:room",
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toBeNull();
  });
});

function hasOrphanedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= s.length || s.charCodeAt(i + 1) < 0xdc00 || s.charCodeAt(i + 1) > 0xdfff) {
        return true;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("buildGroupDisplayTitle", () => {
  it("prefers the native channel name with optional space prefix", () => {
    expect(buildGroupDisplayTitle({ groupChannel: "general" })).toBe("#general");
    expect(buildGroupDisplayTitle({ groupChannel: "#general", space: "Acme" })).toBe(
      "Acme #general",
    );
    expect(buildGroupDisplayTitle({ groupChannel: "general", subject: "Topic" })).toBe("#general");
  });

  it("falls back to the chat subject, then the space, then undefined", () => {
    expect(buildGroupDisplayTitle({ subject: "OpenClaw Devs" })).toBe("OpenClaw Devs");
    expect(buildGroupDisplayTitle({ space: "Acme" })).toBe("Acme");
    expect(buildGroupDisplayTitle({})).toBeUndefined();
    expect(buildGroupDisplayTitle({ subject: "  " })).toBeUndefined();
  });
});

describe("shortenGroupId", () => {
  it("truncates long ASCII strings to prefix...suffix", () => {
    expect(shortenGroupId("abcdefghijklmnop")).toBe("abcdef...mnop");
  });

  it("handles emoji at suffix boundary without orphaned surrogates", () => {
    // Bug: old code used trimmed.slice(-4) which can split a surrogate pair.
    // With the 4-UTF-16-unit suffix, the 😱 at positions 10-11 doesn't fit
    // (start=-4 lands at index 11 = low surrogate → adjusted to 12 → "klm").
    const input = "abcdefghij" + String.fromCodePoint(0x1f631) + "klm";
    const result = shortenGroupId(input);
    expect(hasOrphanedSurrogate(result)).toBe(false);
    expect(result).toBe("abcdef...klm");
  });

  it("preserves emoji at suffix edge when it fits in 4 UTF-16 units", () => {
    // Regression: suffix uses sliceUtf16Safe(input, -4) to take the last
    // 4 UTF-16 code units without splitting surrogates. "😱ab" is exactly 4
    // UTF-16 units (high surr + low surr + a + b) and fits correctly.
    const asciiInput = "0123456789xyabcd";
    expect(shortenGroupId(asciiInput)).toBe("012345...abcd");
    const emojiInput = "0123456789xy😱ab";
    const result = shortenGroupId(emojiInput);
    expect(hasOrphanedSurrogate(result)).toBe(false);
    expect(result).toBe("012345...😱ab");
  });

  it("handles emoji at prefix boundary", () => {
    const input = "abcde" + String.fromCodePoint(0x1f631) + "fghijklmnopqrst";
    const result = shortenGroupId(input);
    expect(hasOrphanedSurrogate(result)).toBe(false);
  });

  it("produces no orphaned surrogates with multiple emoji", () => {
    const emoji = String.fromCodePoint(0x1f631);
    const input = emoji.repeat(10);
    const result = shortenGroupId(input);
    expect(hasOrphanedSurrogate(result)).toBe(false);
  });

  it("stays within the 13-UTF-16-unit budget with all-emoji input", () => {
    // All-emoji input exercises the suffix budget: each emoji = 2 UTF-16 units.
    // Prefix takes 6 UTF-16 units (3 emoji), suffix takes 4 UTF-16 units (2 emoji),
    // "..." adds 3. Total display = 3 + 3 + 2 = 8 code points, 13 UTF-16 units.
    const emoji = String.fromCodePoint(0x1f631);
    const input = emoji.repeat(10);
    const result = shortenGroupId(input);

    // No orphaned surrogates in output
    expect(hasOrphanedSurrogate(result)).toBe(false);
    // Total UTF-16 length stays within the original budget of 13
    expect(result.length).toBeLessThanOrEqual(13);
    // Shows 3 prefix emoji + "..." + 2 suffix emoji
    expect(result).toBe(`${emoji.repeat(3)}...${emoji.repeat(2)}`);
  });

  it("returns short strings unchanged", () => {
    expect(shortenGroupId("short")).toBe("short");
    expect(shortenGroupId("")).toBe("");
  });
});
