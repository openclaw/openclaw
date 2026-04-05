import { describe, expect, it } from "vitest";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "./fences.js";

describe("parseFenceSpans", () => {
  it("parses a simple backtick fence", () => {
    const text = "```js\nconsole.log(1)\n```";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: text.length, marker: "```" });
  });

  it("parses a simple tilde fence", () => {
    const text = "~~~\ncode\n~~~";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: text.length, marker: "~~~" });
  });

  it("does not close a backtick fence when the closing line has content after the marker", () => {
    const text = "```python\nprint('hello')\n```javascript\nprint('world')\n```";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    // ```javascript should NOT close the fence opened by ```python.
    // The entire block from the opening ``` to the final ``` is one span.
    expect(spans[0]).toMatchObject({ start: 0, end: text.length });
  });

  it("does not close a tilde fence when the closing line has content after the marker", () => {
    const text = "~~~sh\necho hi\n~~~ruby\nputs 'hi'\n~~~";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: text.length });
  });

  it("closes a fence when trailing content is spaces only", () => {
    // Trailing text after the fence ensures this is not just an EOF span.
    const text = "```js\ncode\n```   \nafter fence";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    const afterIndex = text.indexOf("after fence");
    expect(spans[0].end).toBeLessThan(afterIndex);
  });

  it("closes a fence when trailing content is a tab", () => {
    const text = "```js\ncode\n```\t\nafter fence";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    const afterIndex = text.indexOf("after fence");
    expect(spans[0].end).toBeLessThan(afterIndex);
  });

  it("closes a fence when trailing content is mixed spaces and tabs", () => {
    const text = "```js\ncode\n``` \t \t\nafter fence";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    const afterIndex = text.indexOf("after fence");
    expect(spans[0].end).toBeLessThan(afterIndex);
  });

  it("does not close a fence when trailing content includes non-breaking space", () => {
    // NBSP (U+00A0) is not a space or tab, so per CommonMark it should not
    // be allowed after a closing fence marker.
    const text = "```js\ncode\n```\u00A0\n```";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: text.length });
  });

  it("handles CRLF line endings correctly", () => {
    const text = "```js\r\ncode\r\n```\r\nafter fence";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    // The trailing \r on the closing ``` line must not prevent fence closing.
    const afterIndex = text.indexOf("after fence");
    expect(spans[0].end).toBeLessThan(afterIndex);
  });

  it("requires closing marker to be at least as long as opening", () => {
    const text = "````\ncode\n```\n````";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: text.length, marker: "````" });
  });

  it("treats unclosed fence as spanning to end of input", () => {
    const text = "```\nsome code without closing";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: text.length });
  });

  it("parses multiple consecutive fences", () => {
    const text = "```\nblock1\n```\ntext\n~~~\nblock2\n~~~";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(2);
  });

  it("does not cross marker types (backtick fence not closed by tildes)", () => {
    const text = "```\ncode\n~~~\nmore code\n```";
    const spans = parseFenceSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: text.length });
  });
});

describe("findFenceSpanAt", () => {
  it("returns the span containing the index", () => {
    const text = "before\n```\ncode\n```\nafter";
    const spans = parseFenceSpans(text);
    const inside = text.indexOf("code");
    expect(findFenceSpanAt(spans, inside)).toBeDefined();
  });

  it("returns undefined for index outside any span", () => {
    const text = "before\n```\ncode\n```\nafter";
    const spans = parseFenceSpans(text);
    expect(findFenceSpanAt(spans, 0)).toBeUndefined();
  });
});

describe("isSafeFenceBreak", () => {
  it("returns false inside a fenced block", () => {
    const text = "```\ncode\n```";
    const spans = parseFenceSpans(text);
    const codeIndex = text.indexOf("code");
    expect(isSafeFenceBreak(spans, codeIndex)).toBe(false);
  });

  it("returns true outside a fenced block", () => {
    const text = "plain\n```\ncode\n```\nplain";
    const spans = parseFenceSpans(text);
    expect(isSafeFenceBreak(spans, 0)).toBe(true);
  });

  it("returns false between fences when inner fence-like line has content", () => {
    const text = "```python\nprint('a')\n```javascript\nprint('b')\n```";
    const spans = parseFenceSpans(text);
    const midpoint = text.indexOf("print('b')");
    expect(isSafeFenceBreak(spans, midpoint)).toBe(false);
  });
});
