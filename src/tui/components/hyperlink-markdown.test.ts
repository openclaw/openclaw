import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { iterateAnsiSegments } from "../../../packages/terminal-core/src/ansi-sequences.js";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { markdownTheme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

function osc8Targets(raw: string) {
  return [...iterateAnsiSegments(raw)].flatMap((segment) => {
    if (segment.kind !== "ansi" || !segment.value.startsWith("\x1b]8;;")) {
      return [];
    }
    const terminatorLength = segment.value.endsWith("\x1b\\") ? 2 : 1;
    const target = segment.value.slice("\x1b]8;;".length, -terminatorLength);
    return target ? [target] : [];
  });
}

describe("HyperlinkMarkdown", () => {
  it("wraps long addresses without inserting spaces into their text", () => {
    const text = "alexandertheodorewilliamson@example.org";
    const constructed = new HyperlinkMarkdown(text, 0, 0, markdownTheme);
    const updated = new HyperlinkMarkdown("previous text", 0, 0, markdownTheme);
    updated.setText(text);

    for (const width of [120, 16]) {
      for (const markdown of [constructed, updated]) {
        const lines = markdown.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.map((line) => stripAnsi(line).trimEnd()).join("")).toBe(text);
      }
    }
  });

  it("links the complete parenthetical URL rendered by pi-tui", () => {
    const url = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
    const markdown = new HyperlinkMarkdown(`[Wikipedia](${url})`, 0, 0, markdownTheme);

    const rendered = markdown.render(120).join("\n");

    expect(rendered).toContain(`\x1b]8;;${url}`);
    expect(normalizeTestText(rendered)).toContain("Wikipedia");
  });

  it("sanitizes constructor and updated markdown before rendering", () => {
    const attack = "\x1b]52;c;Y2xpcGJvYXJk\x07";
    const url = "https://example.test/path?mode=copy-safe#proof";
    const markdown = new HyperlinkMarkdown(`before${attack}after`, 0, 0, markdownTheme);

    expect(markdown.render(80).join("\n")).toContain("beforeafter");
    expect(markdown.render(80).join("\n")).not.toContain(attack);

    markdown.setText(`next\u009b31munsafe\u009b0m ${url}${attack}`);
    const updated = markdown.render(120).join("\n");
    expect(updated).toContain("nextunsafe");
    expect(updated).not.toContain("\u009b");
    expect(updated).toContain(`\x1b]8;;${url}`);
    expect(normalizeTestText(updated)).toContain(url);
    expect(updated).not.toContain("Y2xpcGJvYXJk");
  });

  it("renders a neutral fallback when nonempty markdown sanitizes to empty", () => {
    const markdown = new HyperlinkMarkdown("\x1b]0;title\x07", 0, 0, markdownTheme);

    expect(markdown.render(80).map(normalizeTestText).join("\n")).toContain("(no output)");

    markdown.setText("");
    expect(markdown.render(80).map(normalizeTestText).join("\n")).not.toContain("(no output)");
  });

  it("keeps horizontal padding outside isolates while OSC8 targets wrap intact", () => {
    const url = "https://example.test/rtl-proof/with/a/long/path";
    const lines = new HyperlinkMarkdown(`مرحبا ${url}`, 2, 0, markdownTheme).render(24);
    const rtlLine = lines.find((line) => line.includes("مرحبا"));
    const targets = osc8Targets(lines.join("\n"));

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
    expect(rtlLine?.startsWith("  \u2067")).toBe(true);
    expect(rtlLine?.trimEnd().endsWith("\u2069")).toBe(true);
    expect(rtlLine?.endsWith("  ")).toBe(true);
    expect(targets.length).toBeGreaterThan(1);
    expect(targets.every((target) => target === url)).toBe(true);
  });
});
