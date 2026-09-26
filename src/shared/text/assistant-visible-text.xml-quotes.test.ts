import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { stripToolCallXmlTags } from "./assistant-visible-text.js";
import { isToolCallXmlArtifact } from "./tool-call-xml.js";

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

const invocation = '<invoke name="example"><parameter name="value">a</parameter></invoke>';

describe("complete tool-call XML artifacts", () => {
  it.each([
    invocation,
    `${invocation}\n${invocation}`,
    `<function_calls>${invocation}</function_calls>`,
    '<antml:function_calls><antml:invoke name="example"><antml:parameter name="value">a</antml:parameter></antml:invoke></antml:function_calls>',
    '<invoke name="example"><parameter name="value">a < b and <b>bold</b></parameter></invoke>',
    '<invoke name="example" note="a > b"><parameter name="value">a</parameter></invoke>',
  ])("recognizes an entire complete artifact: %s", (text) => {
    expect(isToolCallXmlArtifact(text)).toBe(true);
  });

  it.each([
    `Use ${invocation} in your prompt.`,
    '<invoke name="example">ordinary prose</invoke>',
    `${invocation}The answer is 42.${invocation}`,
    `    ${invocation}`,
    `\t${invocation}`,
    `<function_calls>${invocation}`,
    "<invoke><parameter>a</invoke>The answer is 42.<invoke><parameter>b</parameter></invoke>",
    "<invoke><parameter>a</antml:parameter></invoke>",
    "<invoke><parameter>a</parameter></invoke/>",
    '<invoke><parameter value="unterminated',
  ])("retains prose, code, or malformed envelopes: %s", (text) => {
    expect(isToolCallXmlArtifact(text)).toBe(false);
  });

  it("handles long sibling lists and missing close tags without regex backtracking", () => {
    const parameters = '<parameter name="value">a</parameter>'.repeat(1024);
    const started = performance.now();
    expect(isToolCallXmlArtifact(`<invoke name="example">${parameters}</invoke>`)).toBe(true);
    expect(isToolCallXmlArtifact(`<invoke name="example">${parameters}`)).toBe(false);
    expect(isToolCallXmlArtifact(`<invoke name="example">${parameters}</invoke>suffix`)).toBe(
      false,
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
