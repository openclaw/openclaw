// UTF-16-safe truncation test for `text.slice(0, maxLen - 1)` in
// truncateTitle (src/gateway/session-utils.ts:228), called from
// deriveSessionTitle when deriving a session name from the first user message.
// The title is capped at DERIVED_TITLE_MAX_LEN = 60 code units, and
// truncation at position 59 can split a surrogate pair.
import { describe, expect, it } from "vitest";
import { truncateUtf16Safe } from "../utils.js";
import { deriveSessionTitle } from "./session-utils.js";

describe("session title truncation", () => {
  it("drops the incomplete emoji pair instead of producing a lone surrogate (maxLen=60)", () => {
    // message = 58 't' + emoji = 60 code units. truncateTitle cuts at
    // maxLen - 1 = 59. emoji high surrogate at index 58 (within the
    // 59-char limit), low surrogate at index 59 (outside).
    // slice(0, 59) → lone high surrogate → U+FFFD.
    // truncateUtf16Safe(59) backs out to 58 code units.
    const msg = "t".repeat(58) + "🚀";
    expect(msg.slice(0, 59).charCodeAt(58)).toBe(0xd83d); // lone high surrogate
    const safe = truncateUtf16Safe(msg, 59);
    expect(new TextDecoder().decode(new TextEncoder().encode(safe))).not.toContain("�");
  });

  it("preserves the complete emoji when it fits fully within the boundary", () => {
    // message = 57 't' + emoji = 59 code units. Both surrogate halves
    // are within the 59-char cut limit — no truncation of the pair needed.
    const msg = "t".repeat(57) + "🚀";
    expect(msg.length).toBe(59);
    expect(truncateUtf16Safe(msg, 59)).toBe(msg);
  });

  it("preserves short titles unchanged", () => {
    expect(truncateUtf16Safe("deploy-cron", 59)).toBe("deploy-cron");
    expect(truncateUtf16Safe("", 59)).toBe("");
  });

  it("deriveSessionTitle has no lone surrogate when first user message emoji crosses the 59-char cut", () => {
    // firstUserMessage = 58 't' + emoji + padding = > 60 code units.
    // truncateTitle cuts at maxLen - 1 = 59, emoji high surrogate at index 58.
    // deriveSessionTitle passes through label/displayName/subject checks first;
    // provide an entry without those so it reaches the firstUserMessage path.
    const firstUserMessage = "t".repeat(58) + "🚀 extra padding so > 60";
    expect(firstUserMessage.length).toBeGreaterThan(60);

    const title = deriveSessionTitle(
      { sessionId: "test-session", updatedAt: Date.now() },
      firstUserMessage,
    );
    expect(title).toBeDefined();

    const rt = new TextDecoder().decode(new TextEncoder().encode(title!));
    expect(rt).not.toContain("�");
  });
});
