// Covers normalizePollEchoText: the poll_vote_echo guard compares an option
// label against the agent's outbound text, and emoji land asymmetrically —
// iMessage options suffix them ("Lobster 🦞 "), the agent's echo prefixes them
// ("🦞 Lobster."). Both sides must shed emoji (across every emoji class) so the
// word cores compare equal, while non-emoji labels stay distinct.
import { describe, expect, it } from "vitest";
import { normalizePollEchoText } from "./message-tool.js";

describe("normalizePollEchoText", () => {
  it("matches an emoji-suffixed option against an emoji-prefixed echo", () => {
    // The exact live regression.
    expect(normalizePollEchoText("Lobster 🦞 ")).toBe("lobster");
    expect(normalizePollEchoText("🦞 Lobster.")).toBe("lobster");
    expect(normalizePollEchoText("Lobster 🦞 ")).toBe(normalizePollEchoText("🦞 Lobster."));
  });

  it("sheds every emoji class, not just pictographic", () => {
    // Regional-indicator flags and subdivision-flag tags are NOT
    // Extended_Pictographic, so the first regex missed them (Codex finding).
    expect(normalizePollEchoText("USA 🇺🇸 ")).toBe("usa");
    expect(normalizePollEchoText("🇺🇸 USA.")).toBe("usa");
    expect(normalizePollEchoText("USA 🇺🇸 ")).toBe(normalizePollEchoText("🇺🇸 USA."));
    expect(normalizePollEchoText("Scotland 🏴󠁧󠁢󠁳󠁣󠁴󠁿")).toBe("scotland");
    // ZWJ sequences and skin-tone modifiers clear fully.
    expect(normalizePollEchoText("Team 👍🏽")).toBe("team");
    expect(normalizePollEchoText("Family 👨‍👩‍👧")).toBe("family");
  });

  it("clears a keycap sequence as a unit but keeps a plain digit/symbol", () => {
    // Keycap "1️⃣" (base + VS16 + U+20E3) must clear whole to "" — not "1" —
    // so an emoji-only keycap label can't wrongly suppress (Codex finding).
    expect(normalizePollEchoText("1️⃣")).toBe("");
    expect(normalizePollEchoText("#️⃣")).toBe("");
    expect(normalizePollEchoText("Option 1️⃣")).toBe("option");
    // A plain "1"/"#"/"*" (no U+20E3) is a real label and must survive so it can
    // still match a plain-text echo.
    expect(normalizePollEchoText("1")).toBe("1");
    expect(normalizePollEchoText("C#")).toBe("c#");
  });

  it("keeps internal/label punctuation so distinct options stay distinct", () => {
    expect(normalizePollEchoText("C#")).toBe("c#");
    expect(normalizePollEchoText("C++")).toBe("c++");
    expect(normalizePollEchoText("Node.js")).toBe("node.js");
    expect(normalizePollEchoText("C#")).not.toBe(normalizePollEchoText("C"));
  });

  it("normalizes a pictographic emoji-only label to empty (guard fails open)", () => {
    // The consume guard requires a non-empty normalized option, so an emoji-only
    // vote gets no echo suppression rather than matching any emoji send.
    expect(normalizePollEchoText("🍎")).toBe("");
    expect(normalizePollEchoText("🍎 ")).toBe("");
  });
});
