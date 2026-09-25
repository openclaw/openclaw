import { describe, expect, it } from "vitest";
import { stripToolCallXmlTags } from "./assistant-visible-text.js";

describe("XML tag quote boundaries", () => {
  it.each([
    'note="left < middle > right"',
    "note='left < middle > right'",
    'note="escaped \\"<> then closed"',
    "note='escaped \\'<> then closed'",
    'note="two backslashes\\\\"',
    "first=\"<>><<\" second='><<>'",
    'note="line one\n<line two>\nline three"',
  ])("preserves parameter text and removes tool payloads with %s", (attributes) => {
    expect(stripToolCallXmlTags(`before<parameter ${attributes}>visible</parameter>after`)).toBe(
      "beforevisibleafter",
    );
    expect(
      stripToolCallXmlTags(`before<tool_call ${attributes}>{"name":"hidden"}</tool_call>after`),
    ).toBe("beforeafter");
  });

  it.each([
    '<parameter note="unclosed > visible</parameter>',
    "<parameter note='unclosed > visible</parameter>",
    "<parameter note=unquoted <span>visible</span></parameter>",
    '<parameter note="trailing escape\\',
  ])("preserves malformed parameter markup without leaking quote state: %s", (text) => {
    expect(stripToolCallXmlTags(text)).toBe(text);
    expect(stripToolCallXmlTags('<parameter note="<>">next</parameter>')).toBe("next");
  });

  it("handles self-closing and successive tags with UTF-16 text around them", () => {
    const text =
      '\ud800🦊<parameter note="<>"/>one<parameter note=\'><\'>two</parameter><tool_call note=">"/>🦊\udfff';
    expect(stripToolCallXmlTags(text)).toBe("\ud800🦊onetwo🦊\udfff");
  });

  it("preserves quoted tag examples in inline and fenced code", () => {
    const text = [
      'Use `<parameter note="<>">visible</parameter>`.',
      "",
      "```xml",
      '<tool_call note="<>">{"name":"example"}</tool_call>',
      "```",
    ].join("\n");
    expect(stripToolCallXmlTags(text)).toBe(text);
  });
});
