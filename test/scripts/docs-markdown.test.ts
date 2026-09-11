import { describe, expect, it } from "vitest";
import { createDocsMarkdown, parseDocsDocument } from "../../scripts/lib/docs-markdown.mjs";

describe("docs Markdown rendering", () => {
  it.each(["", "> "].flatMap((quote) => ["html", "jsx"].map((kind) => ({ quote, kind }))))(
    "keeps list fences after multiline $kind with prefix $quote",
    ({ quote, kind }) => {
      const source = [
        `${quote}10. item`,
        quote.trimEnd(),
        `${quote}    ${kind === "html" ? "<pre>" : "{/*"}`,
        `${quote}    <Card href="/hidden">literal</Card>`,
        quote.trimEnd(),
        `${quote}    continued literal`,
        `${quote}    ${kind === "html" ? "</pre>" : "*/}"}`,
        quote.trimEnd(),
        `${quote}    ~~~html`,
        `${quote}    <code>`,
        `${quote}    ~~~`,
        "",
        '<ParamField path="live" type="string">',
        "[Visible](/visible)",
        "</ParamField>",
        "",
        "~~~html",
        "</code>",
        "~~~",
      ].join("\n");
      const md = createDocsMarkdown();
      const document = parseDocsDocument(source, md, {
        mapLink: (href: string, line: number | undefined) => ({ href, line }),
      });
      const html = md.renderer.render(document.tokens, md.options, document.env);

      expect(
        document.tokens.filter((token) => token.type === "fence").map((token) => token.content),
      ).toEqual(["<code>\n", "</code>\n"]);
      expect(document.ids).toContain("param-live");
      expect(document.links).toEqual([{ href: "/visible", line: 14 }]);
      if (kind === "html") {
        expect(html).toContain('<Card href="/hidden">literal</Card>');
      } else {
        expect(html).not.toContain("/hidden");
        expect(html).not.toContain("continued literal");
      }
      expect(html).not.toContain("<ParamField");
    },
  );

  it.each(["", "<pre>\n> raw literal quote\n</pre>\n"])(
    "removes comment-owned quote and indentation prefixes after %j",
    (prefix) => {
      const source =
        prefix +
        [
          "{/*",
          "    hidden indented comment",
          "",
          "> hidden quoted comment",
          '    <Card href="/hidden">hidden card</Card>',
          "*/}",
          "",
          '<ParamField path="live">',
          "[Visible](/visible)",
          "</ParamField>",
        ].join("\n");
      const md = createDocsMarkdown();
      const document = parseDocsDocument(source, md);
      const html = md.renderer.render(document.tokens, md.options, document.env);

      expect(html).not.toContain("hidden");
      expect(html).not.toContain("<blockquote>");
      expect(document.ids).toContain("param-live");
      expect(document.links).toEqual(["/visible"]);
    },
  );

  it("retains only the containing quote when removing JSX comments", () => {
    const md = createDocsMarkdown();
    const document = parseDocsDocument(
      "> {/*\n> > hidden nested quote\n> */}\n>\n> [Visible](/visible)",
      md,
      { mapLink: (href: string, line: number | undefined) => ({ href, line }) },
    );
    const html = md.renderer.render(document.tokens, md.options, document.env);

    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(html).not.toContain("hidden");
    expect(document.links).toEqual([{ href: "/visible", line: 5 }]);
  });

  it("does not inherit a quote from an earlier raw literal", () => {
    const literal = "<pre>\n> raw literal quote\n</pre>";
    const md = createDocsMarkdown();
    const document = parseDocsDocument(
      `${literal}\n{/*\n> hidden comment quote\n*/}\n\n[Visible](/visible)`,
      md,
    );
    const html = md.renderer.render(document.tokens, md.options, document.env);

    expect(html).toContain(literal);
    expect(html).not.toContain("<blockquote>");
    expect(html).not.toContain("hidden");
    expect(document.links).toEqual(["/visible"]);
  });

  it("preserves JSX comment bytes inside indented code", () => {
    const literal = "{/*\n> literal quote\n\n    literal indentation\n*/}\n";
    const source = `${literal
      .trimEnd()
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}\n\n[Visible](/visible)`;
    const document = parseDocsDocument(source);

    expect(document.tokens.find((token) => token.type === "code_block")?.content).toBe(literal);
    expect(document.links).toEqual(["/visible"]);
  });

  it.each([
    { name: "backtick", fence: "```", quote: "" },
    { name: "tilde", fence: "~~~", quote: "" },
    { name: "blockquote tilde", fence: "~~~", quote: "> " },
  ])(
    "keeps live components between separately fenced raw HTML tags ($name)",
    ({ fence, quote }) => {
      const source = [
        `${quote}${fence}html`,
        quote.trimEnd(),
        `${quote}<code>`,
        `${quote}${fence}`,
        "",
        '<ParamField path="live" type="string">',
        "[Visible](/visible)",
        "</ParamField>",
        "",
        `${quote}${fence}html`,
        `${quote}</code>`,
        `${quote}${fence}`,
      ].join("\n");
      const md = createDocsMarkdown();
      const document = parseDocsDocument(source, md, {
        mapLink: (href: string, line: number | undefined) => ({ href, line }),
      });
      const html = md.renderer.render(document.tokens, md.options, document.env);

      expect(
        document.tokens.filter((token) => token.type === "fence").map((token) => token.content),
      ).toEqual(["\n<code>\n", "</code>\n"]);
      expect(document.ids).toContain("param-live");
      expect(document.links).toEqual([{ href: "/visible", line: 7 }]);
      expect(html).not.toContain("<ParamField");
    },
  );

  it.each([
    "",
    "> ~~~html\n> example\n\n",
    "- ~~~html\n  example\n\n",
    "- Example\n\n  ~~~html\n  example\n\n",
  ])("keeps apparent fences inside raw HTML opaque after %j", (prefix) => {
    const literal = '<pre>\n~~~text\n<Card href="/hidden">literal</Card>\n</pre>';
    const source = `${prefix}${literal}\n\n<ParamField path="live">\n[Visible](/visible)\n</ParamField>`;
    const md = createDocsMarkdown();
    const document = parseDocsDocument(source, md);
    const html = md.renderer.render(document.tokens, md.options, document.env);

    expect(html).toContain(literal);
    expect(html).not.toContain("<ParamField");
    expect(document.ids).toContain("param-live");
    expect(document.links).toEqual(["/visible"]);
  });

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
