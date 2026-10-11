import { describe, expect, it } from "vitest";
import { findWidgetScriptSyntaxError } from "./widget-script-syntax.js";

describe("widget script syntax", () => {
  it.each([
    '<script>const html = "<!--<script></script>-->";</script>',
    "1 < 2 <script>const value = 1;</script>",
    "<!doctype html><script>const value = 1;</script>",
  ])("accepts valid scripts or markup: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each(["type"])("rejects top-level await in classic scripts: %s", (attributes) => {
    expect(
      findWidgetScriptSyntaxError(`<script ${attributes}>await Promise.resolve();</script>`),
    ).toMatchObject({ scriptIndex: 1 });
  });

  it.each(["src"])("skips non-JavaScript and external scripts: %s", (attributes) => {
    expect(findWidgetScriptSyntaxError(`<script ${attributes}>const =</script>`)).toBeUndefined();
  });

  it.each(['<script type="application/json">invalid JS</script>'])(
    "maps the second script after %s and stops at a case-insensitive raw-text close",
    (first) => {
      const widgetCode = `${first}\r\n<p>Text</p>\r\n<script>const a = "</SCRIPT>";</script>`;
      expect(findWidgetScriptSyntaxError(widgetCode)).toEqual({
        message: "Unterminated string constant",
        line: 3,
        column: 18,
        snippet: '<script>const a = "</SCRIPT>";</script>',
        scriptIndex: 2,
      });
    },
  );

  it.each([
    "<!-- <script>const =</script>",
    "<plaintext></plaintext><script>const =</script>",
    '<div title="<script>const =</script>',
  ])("ignores script-looking text outside script elements: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each(["textarea"])("skips %s content and resumes at its actual end tag", (tag) => {
    const prefix = `<${tag}>ignored </${tag}x><script>const =</script></${tag.toUpperCase()} >`;
    expect(findWidgetScriptSyntaxError(prefix)).toBeUndefined();
    expect(findWidgetScriptSyntaxError(`${prefix}\n<script>const =</script>`)).toMatchObject({
      scriptIndex: 1,
      line: 2,
      column: 14,
    });
    expect(findWidgetScriptSyntaxError(`<${tag}><script>const =</script>`)).toBeUndefined();
  });

  it("preserves offsets and script indexes after skipping inert HTML contexts", () => {
    const widgetCode = [
      "<!-- <script>const =</script> -->",
      "<textarea><script>const =</script></textarea>",
      '<div title="İ <script>const =</script>"></div>',
      "  <script>const =</script>",
    ].join("\n");
    expect(findWidgetScriptSyntaxError(widgetCode)).toEqual({
      message: "Unexpected token",
      scriptIndex: 1,
      line: 4,
      column: 16,
      snippet: "<script>const =</script>",
    });
  });

  it.each([
    '<div><svg><foreignObject><script>const text = "<![CDATA[";</script></foreignObject></svg></div>',
    "<svg><foreignObject/><script><![CDATA[const value = 1;]]></script></svg>",
  ])("parses CDATA-wrapped scripts in SVG: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each([
    "<svg><title/></svg><script>const =</script>",
    "<svg><text><![CDATA[text]]></text></svg><script>const =</script>",
  ])("still reaches scripts after self-closing or CDATA foreign content: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)).toMatchObject({ line: 1 });
  });

  it.each(["<svg><svg/></svg>"])(
    "leaves CDATA markers outside SVG untouched after %s",
    (prefix) => {
      expect(
        findWidgetScriptSyntaxError(`${prefix}<script><![CDATA[const value = 1;]]></script>`),
      ).toMatchObject({ message: "Unexpected token", scriptIndex: 1 });
    },
  );

  it.each(["&#109;odule"])(
    "validates scripts whose type contains character references: %s",
    (type) => {
      expect(findWidgetScriptSyntaxError(`<script type="${type}">const =</script>`)).toMatchObject({
        message: "Unexpected token",
        scriptIndex: 1,
      });
    },
  );
});
