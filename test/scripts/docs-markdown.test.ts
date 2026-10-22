import { describe, expect, it } from "vitest";
import { createDocsMarkdown, parseDocsDocument } from "../../scripts/lib/docs-markdown.mjs";

const mapLink = (href: string, line: number | undefined) => ({ href, line });
function render(source: string, mapLines = false) {
  const md = createDocsMarkdown();
  const document = parseDocsDocument(source, md, mapLines ? { mapLink } : undefined);
  return {
    document,
    html: md.renderer.render(document.tokens, md.options, document.env),
    fences: document.tokens.filter((token) => token.type === "fence").map((token) => token.content),
  };
}

const visibleParam = '<ParamField path="live">\n[Visible](/visible)\n</ParamField>';
const indent = (text: string, prefix: string) =>
  text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
const fence = (body: string, info: string, prefix = "") =>
  indent(`\`\`\`${info}\n${body}\n\`\`\``, prefix);
function expectVisible(document: ReturnType<typeof parseDocsDocument>, line?: number) {
  expect(document.ids).toContain("param-live");
  expect(document.links).toEqual(line ? [{ href: "/visible", line }] : ["/visible"]);
}

describe("docs Markdown rendering", () => {
  it("preserves nested fence indentation with CRLF", () => {
    const body = '{\n  "features": {\n    "example": "<Tab title=\\"literal\\">"\n  }\n}';
    const yaml = "app:\n  scopes:\n    - chat:write\n  description: |\n    Nested content";
    const source = [
      '<Tabs>\n  <Tab title="Manifest">\n    <Steps>\n      <Step title="Create app">\n        <CodeGroup>',
      fence(body, "json Recommended"),
      fence(body, "json Minimal", "          "),
      fence(yaml, "yaml", "  "),
      "        </CodeGroup>\n      </Step>\n    </Steps>\n  </Tab>\n</Tabs>",
      '<ParamField path="live">[Visible](/visible)</ParamField>',
      fence(body, "json"),
    ]
      .join("\n")
      .replaceAll("\n", "\r\n");
    const { document, fences } = render(source);
    expect(fences).toEqual([`${body}\n`, `${body}\n`, `${yaml}\n`, `${body}\n`]);
    expectVisible(document);
  });

  it.each([
    ["APIUsage", "سلوك إعادة المحاولة", ["param-apiusage", "slwk-ieadt-almhawlt"]],
    [
      "APISection fooBar APIs DNS2API",
      "ու ՈՒ Ու aŒb aœb aƏb aəb ẞ",
      ["param-api-section-foo-bar-apis-dns-2-api", "vo-vo-vo-a-b-a-b-a-b-a-b-ss"],
    ],
    ["a𝓀b a𝕆b aⓒb aⓓb", "Conway’s Law — DON’T", ["param-ahb-a-nb-a-b-b-a-c-b", "conways-law-dont"]],
    ["ŌōfooBar", "before−after before⁓after", ["param-oofoo-bar", "before-after-before-after"]],
  ])("preserves published component anchors for %s", (name, title, ids) => {
    const document = parseDocsDocument(
      `<ParamField body="${name}">Usage</ParamField>\n\n` +
        `<Accordion title="${title}">Details</Accordion>`,
    );

    expect(document.ids).toEqual(ids);
  });

  it.each(["html", "jsx"])("keeps quoted list fences after multiline %s", (kind) => {
    const source = [
      `> 10. item\n>\n>     ${kind === "html" ? "<pre>" : "{/*"}`,
      '>     <Card href="/hidden">literal</Card>\n>\n>     continued literal',
      `>     ${kind === "html" ? "</pre>" : "*/}"}\n>`,
      ">     ~~~html\n>     <code>\n>     ~~~\n",
      '<ParamField path="live" type="string">\n[Visible](/visible)\n</ParamField>\n',
      "~~~html\n</code>\n~~~",
    ].join("\n");
    const { document, html, fences } = render(source, true);
    expect(fences).toEqual(["<code>\n", "</code>\n"]);
    expectVisible(document, 14);
    if (kind === "html") {
      expect(html).toContain('<Card href="/hidden">literal</Card>');
    } else {
      expect(html).not.toContain("/hidden");
      expect(html).not.toContain("continued literal");
    }
    expect(html).not.toContain("<ParamField");
  });

  it("removes comment-owned quote and indentation prefixes after raw HTML", () => {
    const prefix = "<pre>\n> raw literal quote\n</pre>\n";
    const source =
      prefix +
      '{/*\n    hidden indented comment\n\n> hidden quoted comment\n    <Card href="/hidden">hidden card</Card>\n*/}\n\n' +
      visibleParam;
    const { document, html } = render(source);

    expect(html).not.toContain("hidden");
    expect(html).not.toContain("<blockquote>");
    expect(html).toContain(prefix.trimEnd());
    expectVisible(document);
  });

  it("retains only the containing quote when removing JSX comments", () => {
    const { document, html } = render(
      "> {/*\n> > hidden nested quote\n> */}\n>\n> [Visible](/visible)",
      true,
    );

    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(html).not.toContain("hidden");
    expect(document.links).toEqual([{ href: "/visible", line: 5 }]);
  });

  it("preserves JSX comment bytes inside indented code", () => {
    const literal = "{/*\n> literal quote\n\n    literal indentation\n*/}\n";
    const source = `${indent(literal.trimEnd(), "    ")}\n\n[Visible](/visible)`;
    const document = parseDocsDocument(source);

    expect(document.tokens.find((token) => token.type === "code_block")?.content).toBe(literal);
    expect(document.links).toEqual(["/visible"]);
  });

  it("keeps apparent fences inside raw HTML opaque after a list fence", () => {
    const prefix = "- Example\n\n  ~~~html\n  example\n\n";
    const literal = '<pre>\n~~~text\n<Card href="/hidden">literal</Card>\n</pre>';
    const { document, html } = render(`${prefix}${literal}\n\n${visibleParam}`);

    expect(html).toContain(literal);
    expect(html).not.toContain("<ParamField");
    expectVisible(document);
  });

  it("keeps inline pre examples literal before a later HTML example", () => {
    const source = [
      "Intro with `<pre>`.",
      '<ParamField path="source" type="string">\n' +
        "  Pass `<pre>` or ``<pre> with a ` backtick``.\n" +
        "  Or `<pre>\n  attributes`.\n</ParamField>",
      fence("<pre>example</pre>", "html"),
      "## After the example",
      "[Related](/related)",
    ].join("\n\n");
    const { document, html } = render(source);
    expect(html).toContain("<code>&lt;pre&gt;</code>");
    expect(html).toContain("<code>&lt;pre&gt; with a ` backtick</code>");
    expect(html).toContain("<code>&lt;pre&gt; attributes</code>");
    expect(html).toContain("&lt;pre&gt;example&lt;/pre&gt;");
    expect(html).not.toContain("<ParamField");
    expect(document.ids).toContain("param-source");
    expect(document.ids).toContain("after-the-example");
    expect(document.links).toEqual(["/related"]);
  });

  it("preserves raw HTML containing backticks after an unmatched backtick", () => {
    const prefix = "Unmatched `\n\n";
    const literal = '<script>const example = `<Card href="/hidden" />`;</script>';
    const { document, html } = render(`${prefix}${literal}\n\n[Visible](/visible)`);
    expect(html).toContain(literal);
    expect(html).not.toContain("OPENCLAW_DOCS_MARKER");
    expect(document.links).toEqual(["/visible"]);
  });
});
