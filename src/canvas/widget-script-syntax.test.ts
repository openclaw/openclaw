import { describe, expect, it } from "vitest";
import { findWidgetScriptSyntaxError } from "./widget-script-syntax.js";

describe("widget script syntax", () => {
  it("maps a raw newline in a single-quoted string to the original widget line", async () => {
    const widgetCode = "\n<section>\n  <script>const a='x\n'+b;</script>\n</section>";
    expect(await findWidgetScriptSyntaxError(widgetCode)).toEqual({
      message: "Unterminated string constant",
      line: 3,
      column: 18,
      snippet: "<script>const a='x",
      scriptIndex: 1,
    });
  });

  it.each([
    "<p>No scripts</p>",
    '<script>const html = "<!--<script></script>-->";</script>',
    '<script>a = "<!--"; </script>',
    '<script>const html = "<!--<script></script>";</script>',
    '<script>const html = "<!--<script>-->";</script>',
    '<script>const html = "<!--<ScRiPt/></SCRIPT>-->";</script>',
    '<script type="&#109;odule">await Promise.resolve();</script>',
    "<script>#!/usr/bin/env node\nconst a=1;</script>",
    '<script>const value = "</scripture>";</script>',
    "<script-example>const =</script-example>",
    "1 < 2 <script>const value = 1;</script>",
    "<!doctype html><script>const value = 1;</script>",
    "<script>const a='x\\n'; document.body.textContent = a;</script>",
    '<script type="module">const value = await Promise.resolve(1); export { value };</script>',
    '<script type=" Text/JavaScript ">const value = 1;</script>',
    '<script data-label="src=ignored > type=application/json">const value = 1;</SCRIPT>',
    '<button onclick="const =">Handlers are not parsed</button>',
  ])("accepts valid scripts or markup: %s", async (widgetCode) => {
    expect(await findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each([
    "",
    "type",
    "type='text/javascript'",
    "type=application/javascript",
    'TYPE=" TEXT/ECMASCRIPT "',
  ])("rejects top-level await in classic scripts: %s", async (attributes) => {
    expect(
      await findWidgetScriptSyntaxError(`<script ${attributes}>await Promise.resolve();</script>`),
    ).toMatchObject({ scriptIndex: 1 });
  });

  it("does not allow wrapped-function grammar", async () => {
    expect(await findWidgetScriptSyntaxError("<script>return 1;</script>")).toBeDefined();
  });

  it.each(['type="application/json"', "SRC=script.js", "src"])(
    "skips non-JavaScript and external scripts: %s",
    async (attributes) => {
      expect(
        await findWidgetScriptSyntaxError(`<script ${attributes}>const =</script>`),
      ).toBeUndefined();
    },
  );

  it.each(["<script>const a = 1;</script>", '<script type="application/json">invalid JS</script>'])(
    "maps the second script after %s and stops at a case-insensitive raw-text close",
    async (first) => {
      const widgetCode = `${first}\r\n<p>Text</p>\r\n<script>const a = "</SCRIPT>";</script>`;
      expect(await findWidgetScriptSyntaxError(widgetCode)).toEqual({
        message: "Unterminated string constant",
        line: 3,
        column: 18,
        snippet: '<script>const a = "</SCRIPT>";</script>',
        scriptIndex: 2,
      });
    },
  );

  it("reports only the first error across multiple scripts", async () => {
    expect(
      await findWidgetScriptSyntaxError("<script>const =</script><script>let =</script>"),
    ).toMatchObject({ scriptIndex: 1, line: 1, column: 14 });
  });

  it.each([
    "<!-- <script>const =</script>",
    "<div title='<script>const =</script>'>Text</div>",
    "<plaintext></plaintext><script>const =</script>",
    '<div title="<script>const =</script>',
  ])("ignores script-looking text outside script elements: %s", async (widgetCode) => {
    expect(await findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each(["style", "textarea"])(
    "skips %s content and resumes at its actual end tag",
    async (tag) => {
      const prefix = `<${tag}>ignored </${tag}x><script>const =</script></${tag.toUpperCase()} >`;
      expect(await findWidgetScriptSyntaxError(prefix)).toBeUndefined();
      expect(
        await findWidgetScriptSyntaxError(`${prefix}\n<script>const =</script>`),
      ).toMatchObject({
        scriptIndex: 1,
        line: 2,
        column: 14,
      });
      expect(await findWidgetScriptSyntaxError(`<${tag}><script>const =</script>`)).toBeUndefined();
    },
  );

  it("preserves offsets and script indexes after skipping inert HTML contexts", async () => {
    const widgetCode = [
      "<!-- <script>const =</script> -->",
      "<textarea><script>const =</script></textarea>",
      '<div title="İ <script>const =</script>"></div>',
      "  <script>const =</script>",
    ].join("\n");
    expect(await findWidgetScriptSyntaxError(widgetCode)).toEqual({
      message: "Unexpected token",
      scriptIndex: 1,
      line: 4,
      column: 16,
      snippet: "<script>const =</script>",
    });
  });

  it.each(["</script/>", '</script foo="bar">', "</SCRIPT >", ""])(
    "parses the script body through its terminator or EOF: %s",
    async (endTag) => {
      expect(await findWidgetScriptSyntaxError(`<script>const =${endTag}`)).toMatchObject({
        scriptIndex: 1,
        line: 1,
        column: 14,
      });
      expect(
        await findWidgetScriptSyntaxError(`<script>const value = 1;${endTag}`),
      ).toBeUndefined();
      if (endTag) {
        expect(
          await findWidgetScriptSyntaxError(
            `<script>const value = 1;${endTag}\n<script>const =</script>`,
          ),
        ).toMatchObject({ scriptIndex: 2, line: 2, column: 14 });
      }
    },
  );

  it.each([
    '<script>const html = "<script></script>";</script>',
    '<script>const html = "<!--<scripture></script>";</script>',
  ])("ends script data unless the exact script token double-escapes it: %s", async (widgetCode) => {
    expect((await findWidgetScriptSyntaxError(widgetCode))?.message).toBe(
      "Unterminated string constant",
    );
  });

  it.each([
    "<svg><svg></svg><script><![CDATA[const value = 1;]]></script></svg>",
    '<svg><script><![CDATA[const text = "</script>";]]></script></svg>',
    "<div><svg><text><![CDATA[Example: > <script>const =</script>]]></text></svg></div>",
    '<div><svg><foreignObject><script>const text = "<![CDATA[";</script></foreignObject></svg></div>',
    "<svg><foreignObject/><script><![CDATA[const value = 1;]]></script></svg>",
    '<SVG xmlns="http://www.w3.org/2000/svg"><script> \n<![CDATA[const value = 1;]]> \n</script></SVG>',
  ])("parses CDATA-wrapped scripts in SVG: %s", async (widgetCode) => {
    expect(await findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each([
    {
      widgetCode: "<svg><script><![CDATA[const =]]></script></svg>",
      line: 1,
      column: 28,
      snippet: "<svg><script><![CDATA[const =]]></script></svg>",
    },
    {
      widgetCode: "<svg>\r\n<script>\n<![CDATA[\nconst =\n]]>\n</script></svg>",
      line: 4,
      column: 6,
      snippet: "const =",
    },
  ])(
    "maps CDATA errors to the original widget: $widgetCode",
    async ({ widgetCode, line, column, snippet }) => {
      expect(await findWidgetScriptSyntaxError(widgetCode)).toEqual({
        message: "Unexpected token",
        scriptIndex: 1,
        line,
        column,
        snippet,
      });
    },
  );

  it.each([
    "<svg><title/></svg><script>const =</script>",
    "<svg><style/><script>const =</script></svg>",
    '<svg><script><![CDATA[const text = "</script>";]]></script></svg><script>const =</script>',
    "<svg><text><![CDATA[text]]></text></svg><script>const =</script>",
    "<svg><foreignObject><script>const =</script></foreignObject></svg>",
    "<svg><foreignObject><script><![CDATA[const value = 1;]]></script></foreignObject></svg>",
  ])(
    "still reaches scripts after self-closing or CDATA foreign content: %s",
    async (widgetCode) => {
      expect(await findWidgetScriptSyntaxError(widgetCode)).toMatchObject({ line: 1 });
    },
  );

  it.each(["", "<svg/>", "<svg></svg>", "<svg><svg/></svg>"])(
    "leaves CDATA markers outside SVG untouched after %s",
    async (prefix) => {
      expect(
        await findWidgetScriptSyntaxError(`${prefix}<script><![CDATA[const value = 1;]]></script>`),
      ).toMatchObject({ message: "Unexpected token", scriptIndex: 1 });
    },
  );

  it.each(["text&#47;javascript", "text&sol;javascript", "&#109;odule"])(
    "validates scripts whose type contains character references: %s",
    async (type) => {
      expect(
        await findWidgetScriptSyntaxError(`<script type="${type}">const =</script>`),
      ).toMatchObject({
        message: "Unexpected token",
        scriptIndex: 1,
      });
    },
  );

  it("bounds the offending line snippet", async () => {
    const widgetCode = `<script>const = ${"x".repeat(1_000)}</script>`;
    expect((await findWidgetScriptSyntaxError(widgetCode))?.snippet).toBe(widgetCode.slice(0, 160));
  });

  it("keeps an emoji whole when the offending line hits the snippet cap", async () => {
    const prefix = `<script>${"a".repeat(151)}`;
    const widgetCode = `${prefix}😀 const =</script>`;
    expect((await findWidgetScriptSyntaxError(widgetCode))?.snippet).toBe(prefix);
  });

  it("keeps an astral identifier whole when the parser message hits its cap", async () => {
    const prefix = "a".repeat(187);
    const identifier = `${prefix}\u{1D400}`;
    const widgetCode = `<script>let ${identifier}=1;let ${identifier}=2;</script>`;
    expect((await findWidgetScriptSyntaxError(widgetCode))?.message).toBe(`Identifier '${prefix}`);
  });
});
