import { describe, expect, it } from "vitest";
import { normalizeTerminalFontFamily, terminalFontFamily } from "./terminal-font.ts";

describe("terminal font family", () => {
  const defaultFamily = terminalFontFamily();
  it("keeps a local family ahead of the bundled glyph fallback", () => {
    expect(normalizeTerminalFontFamily("  FiraCode   Nerd Font Mono  ")).toBe(
      "FiraCode Nerd Font Mono",
    );
    expect(terminalFontFamily("Fira Code")).toBe('"Fira Code", ' + defaultFamily);
    expect(defaultFamily).toContain('"OpenClaw Nerd Symbols"');
    expect(terminalFontFamily("   ")).toBe(defaultFamily);
  });
  it.each([
    undefined,
    12,
    "",
    " ",
    "A".repeat(101),
    '"Fira Code"',
    "Fira Code, serif",
    "Font; color: red",
    'url("https://example.test/font")',
    "bad\\name",
    "bad\u0000name",
  ])("rejects non-family input %s", (value) => {
    expect(normalizeTerminalFontFamily(value)).toBeUndefined();
  });
});
