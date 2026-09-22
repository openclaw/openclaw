import { describe, expect, it } from "vitest";
import { isolateRtlRenderedLine } from "./tui-formatters.js";

describe("rendered line RTL isolation", () => {
  it.each([
    ["ESC with ST", "\x1b]8;;https://example.test/שלום\x1b\\", "\x1b]8;;\x1b\\"],
    ["ESC with BEL", "\x1b]8;;https://example.test/مرحبا\x07", "\x1b]8;;\x07"],
    ["C1 with ST", "\u009d8;;https://example.test/שלום\u009c", "\u009d8;;\u009c"],
  ])("keeps %s hyperlink destinations out of the visible direction decision", (_, open, close) => {
    const ltr = `  ${open}\x1b[1mOpen report 東京 👋\x1b[0m${close}  `;
    expect(isolateRtlRenderedLine(ltr)).toBe(ltr);

    const rtl = `${open}\x1b[1mשלום\x1b[0m${close}`;
    expect(isolateRtlRenderedLine(`  ${rtl}  `)).toBe(`  \u2067${rtl}\u2069  `);
  });
});
