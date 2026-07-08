import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// UTF-16-safe truncation test for `plugin.description.slice(0, 57)` in
// formatPluginLine (src/cli/plugins-list-format.ts). When the description
// needs truncating (length > 60), the last 3 characters are replaced with
// "..." with truncation at position 57, which can split a surrogate pair.
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { formatPluginLine } from "./plugins-list-format.js";

describe("plugin description truncation", () => {
  it("drops the incomplete emoji pair instead of producing a lone surrogate (maxChars=57)", () => {
    // description = 56 'd' + emoji + "x" = 59 code units. emoji high surrogate
    // at index 56. slice(0, 57) includes the lone high surrogate → broken char.
    // truncateUtf16Safe(57) detects incomplete pair and backs out to 56 pure 'd'.
    const desc = `${"d".repeat(56)}🚀x`;
    expect(desc.slice(0, 57).charCodeAt(56)).toBe(0xd83d); // lone high surrogate
    expect(truncateUtf16Safe(desc, 57)).toBe("d".repeat(56)); // pair dropped cleanly
  });

  it("keeps the complete emoji when it fits fully within the boundary", () => {
    // description = 55 'd' + emoji = 57 code units. Both surrogate halves
    // are within the 57-char limit — no truncation needed.
    const desc = "d".repeat(55) + "🚀";
    expect(desc.length).toBe(57);
    expect(truncateUtf16Safe(desc, 57)).toBe(desc);
  });

  it("preserves descriptions shorter than the limit unchanged", () => {
    expect(truncateUtf16Safe("Discord gateway plugin", 57)).toBe("Discord gateway plugin");
    expect(truncateUtf16Safe("", 57)).toBe("");
  });

  it("formatPluginLine non-verbose output has no lone surrogate when emoji crosses the 57-char boundary", () => {
    // description = 56 'd' + emoji + "extra" = 63 code units (> 60, triggers
    // truncation at position 57). emoji high surrogate at index 56 (inside the
    // 57-char limit), low surrogate at index 57 (outside).
    // raw slice(0, 57) → lone high surrogate → U+FFFD.
    // truncateUtf16Safe backs off to 56 → clean 56 'd' + "...".
    const plugin = createPluginRecord({
      id: "emoji-test",
      name: "Emoji Test",
      description: "d".repeat(56) + "🚀extra",
    });
    const desc = plugin.description!;
    expect(desc.length).toBeGreaterThan(60);

    const output = formatPluginLine(plugin, false);

    // Round-trip through TextEncoder → TextDecoder exposes lone surrogates
    // as U+FFFD. The output must contain no replacement characters.
    const rt = new TextDecoder().decode(new TextEncoder().encode(output));
    expect(rt).not.toContain("�");
    // The safe-truncated description (56 'd' + "...") must appear.
    expect(output).toContain("d".repeat(56));
    // The emoji must not appear (it was split across the boundary and backed off).
    expect(output).not.toContain("🚀");
  });

  it("formatPluginLine preserves complete emoji within the 57-char boundary when description is long", () => {
    // description = 55 'd' + emoji + "extra" = 62 code units (> 60, triggers
    // truncation). Both surrogate halves (indices 55-56) are within the 57-char
    // limit — truncateUtf16Safe keeps them intact and appends "...".
    const plugin = createPluginRecord({
      id: "emoji-intact",
      name: "Emoji Intact",
      description: "d".repeat(55) + "🚀extra",
    });
    const desc = plugin.description!;
    expect(desc.length).toBeGreaterThan(60);

    const output = formatPluginLine(plugin, false);

    // Round-trip through TextEncoder → TextDecoder exposes lone surrogates
    // as U+FFFD. The output must contain no replacement characters.
    const rt = new TextDecoder().decode(new TextEncoder().encode(output));
    expect(rt).not.toContain("�");
    // The full emoji must be preserved in the output.
    expect(output).toContain("🚀");
  });
});
