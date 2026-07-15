// Avatar projection limits stay browser-safe and independent of persisted config validation.
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_DATA_URL_CHARS, isRenderableAvatarImageDataUrl } from "./avatar-limits.js";

describe("isRenderableAvatarImageDataUrl", () => {
  it("accepts the exact encoded boundary and rejects larger or non-image data URLs", () => {
    const prefix = "data:image/svg+xml;base64,";
    const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;

    expect(exact).toHaveLength(AVATAR_MAX_DATA_URL_CHARS);
    expect(isRenderableAvatarImageDataUrl(exact)).toBe(true);
    expect(isRenderableAvatarImageDataUrl(`${exact}A`)).toBe(false);
    expect(isRenderableAvatarImageDataUrl("data:text/plain,avatar")).toBe(false);
  });

  it("uses UTF-8 byte length, not UTF-16 code unit count", () => {
    // Non-ASCII characters like 馃榾 (U+1F600) are 2 UTF-16 code units but 4 UTF-8 bytes.
    // The old String.length check would count 2, under-reporting the actual payload size.
    // The fix uses TextEncoder to count actual UTF-8 bytes.
    const prefix = "data:image/svg+xml,";

    // Build a payload with multi-byte characters that fits exactly at the byte boundary.
    // 2 脳 馃榾 = 8 UTF-8 bytes, but only 4 UTF-16 code units.
    const emoji = "馃榾";
    const twoEmojiBytes = 4 * 2; // 8 UTF-8 bytes
    const asciiPart = "A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length - twoEmojiBytes);
    const mixedUrlAtBoundary = ${prefix};
    expect(isRenderableAvatarImageDataUrl(mixedUrlAtBoundary)).toBe(true);

    // One byte over the limit should be rejected
    const oneByteOver = ${mixedUrlAtBoundary}A;
    expect(isRenderableAvatarImageDataUrl(oneByteOver)).toBe(false);
  });});
