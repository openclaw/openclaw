import { describe, expect, it } from "vitest";
import { createDocsMarkdown, parseDocsDocument } from "../../scripts/lib/docs-markdown.mjs";

describe("docs Markdown rendering", () => {
  it.each(["pre", "code", "script", "style", "textarea"])(
    "keeps inline <%s> examples literal before a later HTML example",
    (tag) => {
      const source = [
        `Intro with \`<${tag}>\`.`,
        "",
        '<ParamField path="source" type="string">',
        `  Pass \`<${tag}>\` or \`\`<${tag}> with a \` backtick\`\`.`,
        `  Or \`<${tag}>\n  attributes\`.`,
        "</ParamField>",
        "",
        "```html",
        `<${tag}>example</${tag}>`,
        "```",
        "",
        "## After the example",
        "",
        "[Related](/related)",
      ].join("\n");
      const md = createDocsMarkdown();
      const document = parseDocsDocument(source, md);
      const html = md.renderer.render(document.tokens, md.options, document.env);
      expect(html).toContain(`<code>&lt;${tag}&gt;</code>`);
      expect(html).toContain(`<code>&lt;${tag}&gt; with a \` backtick</code>`);
      expect(html).toContain(`<code>&lt;${tag}&gt; attributes</code>`);
      expect(html).toContain(`&lt;${tag}&gt;example&lt;/${tag}&gt;`);
      expect(html).not.toContain("<ParamField");
      expect(document.ids).toContain("param-source");
      expect(document.ids).toContain("after-the-example");
      expect(document.links).toEqual(["/related"]);
    },
  );

  it.each(["", "Unmatched `\n", "Unmatched `\n\n"])(
    "preserves raw HTML containing backticks after %j",
    (prefix) => {
      const literal = '<script>const example = `<Card href="/hidden" />`;</script>';
      const md = createDocsMarkdown();
      const document = parseDocsDocument(`${prefix}${literal}\n\n[Visible](/visible)`, md);
      const html = md.renderer.render(document.tokens, md.options, document.env);
      expect(html).toContain(literal);
      expect(html).not.toContain("OPENCLAW_DOCS_MARKER");
      expect(document.links).toEqual(["/visible"]);
    },
  );

  it("preserves raw HTML after an unmatched backtick and a CRLF blank line", () => {
    const literal = '<code>const example = `<Card href="/hidden" />`;</code>';
    const md = createDocsMarkdown();
    const document = parseDocsDocument(
      `Unmatched \`\r\n\r\n${literal}\r\n\r\n[Visible](/visible)`,
      md,
    );
    const html = md.renderer.render(document.tokens, md.options, document.env);
    expect(html).toContain(
      "<code>const example = <code>&lt;Card href=&quot;/hidden&quot; /&gt;</code>;</code>",
    );
    expect(html).not.toContain("OPENCLAW_DOCS_MARKER");
    expect(document.links).toEqual(["/visible"]);
  });
});
