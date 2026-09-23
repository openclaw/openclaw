import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markerPrefix, parseAttrs, parseDocsDocument } from "../../scripts/lib/docs-markdown.mjs";

function componentPayload(source: string, kind: string) {
  const document = parseDocsDocument(source);
  const token = document.tokens.find((entry) =>
    entry.content.startsWith(`${markerPrefix}:${kind}:`),
  );
  const encodedPayload = token?.content.split(":")[2];
  assert.ok(encodedPayload !== undefined, `Missing ${kind} renderer payload`);
  return {
    document,
    payload: Buffer.from(encodedPayload, "base64url").toString(),
  };
}

function componentAttrs(source: string, kind: string) {
  const { document, payload } = componentPayload(source, kind);
  return { document, attrs: parseAttrs(payload) };
}

describe("docs component attribute boundaries", () => {
  it.each([
    [
      '<ParamField path="--section <section>" type="string">Filter.</ParamField>',
      { path: "--section <section>", type: "string" },
    ],
    [
      "<ResponseField name='--key <key>' type='string > null'>Value.</ResponseField>",
      { name: "--key <key>", type: "string > null" },
    ],
  ])("preserves parameter labels and types in %s", (source, expected) => {
    const { document, attrs } = componentAttrs(source, "paramOpen");
    expect(attrs).toEqual(expected);
    expect(
      document.tokens
        .filter((token) => token.type === "inline" && !token.content.startsWith(markerPrefix))
        .map((token) => token.content),
    ).toEqual([source.includes("Filter.") ? "Filter." : "Value."]);
  });

  it.each([
    ['<Chart title="A > B" type="bar" />', ""],
    ["<Chart title='A > B' type='bar'>chart data</Chart>", "chart data"],
  ])("preserves chart attributes and body in %s", (source, body) => {
    const { payload } = componentPayload(source, "chart");
    const chart = JSON.parse(payload);
    expect(parseAttrs(chart.attrs)).toEqual({ title: "A > B", type: "bar" });
    expect(chart.body).toBe(body);
  });

  it("starts Mermaid content after the complete opening tag", () => {
    expect(
      componentPayload('<Mermaid title="A > B">graph LR; A-->B</Mermaid>', "mermaidBlock").payload,
    ).toBe("graph LR; A-->B");
  });

  it("expands snippets with quoted angle brackets before the file attribute", () => {
    const root = path.resolve(import.meta.dirname, "../../docs");
    const file = "snippets/plugin-publish/minimal-package.json";
    const document = parseDocsDocument(`<Snippet title="Use <key>" file="${file}" />`, undefined, {
      sourceFile: path.join(root, "index.md"),
      root,
    });
    const expected = parseDocsDocument(fs.readFileSync(path.join(root, file), "utf8"));
    expect(document.tokens.map((token) => [token.type, token.content])).toEqual(
      expected.tokens.map((token) => [token.type, token.content]),
    );
  });

  it("preserves sibling titles, links, self-closing tags and source locations", () => {
    const source = '<Card title="Use <key> > default" href="/cli/config#root-options" />';
    const { attrs } = componentAttrs(source, "cardSelf");
    expect(attrs).toMatchObject({ title: "Use <key> > default", href: "/cli/config#root-options" });
    expect(
      parseDocsDocument(source, undefined, {
        mapLink: (href: string, line: number | undefined) => ({ href, line }),
      }).links,
    ).toEqual([{ href: "/cli/config#root-options", line: 1 }]);
  });

  it("keeps indented content and component anchors after a quoted closing angle bracket", () => {
    const source = '<Steps>\n  <Step title="A > B">\n    [Guide](/cli/config)\n  </Step>\n</Steps>';
    const { document, attrs } = componentAttrs(source, "stepOpen");
    expect(attrs.title).toBe("A > B");
    expect(document.links).toEqual(["/cli/config"]);
    expect(document.ids).toContain("a-%3E-b");
  });
});
