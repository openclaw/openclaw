import { assert, describe, expect, it } from "vitest";
import {
  inlineMarkerPrefix,
  markerPrefix,
  parseDocsDocument,
} from "../../scripts/lib/docs-markdown.mjs";

describe("docs component literal attributes", () => {
  it.each([
    [
      "Accordion",
      "accordionOpen",
      "Registered recall tools return `status=policy-disabled`",
      "registered-recall-tools-return-status-policy-disabled",
    ],
    [
      "Expandable",
      "accordionOpen",
      "First recall returns `status=timeout`",
      "first-recall-returns-status-timeout",
    ],
    ["Step", "stepOpen", "Run `openclaw status`", "run-%60openclaw-status%60"],
    ["Tab", "tabOpen", "Use `default`", "use-%60default%60"],
    ["Card", "cardOpen", "Inspect `config`", undefined],
    ["Tooltip", "tooltipOpen", "The `config` value", undefined],
  ])("preserves inline code in %s attributes before publishing", (name, kind, title, id) => {
    const document = parseDocsDocument(`<${name} title="${title}">Body.</${name}>`);
    const token = document.tokens.find(
      (entry) => entry.type === "inline" && entry.content.includes(`:${kind}:`),
    );
    const prefix = name === "Tooltip" ? inlineMarkerPrefix : markerPrefix;
    const encoded = token?.content.match(new RegExp(`${prefix}:${kind}:([A-Za-z0-9_-]+)`))?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded!, "base64url").toString("utf8")).toBe(` title="${title}"`);
    expect(document.ids).toEqual(id ? [id] : []);
  });

  it.each([
    ['<Mermaid>graph LR\nA["`value`"]</Mermaid>', "mermaidBlock", 'graph LR\nA["`value`"]'],
    ['<Chart title="A `value`" />', "chart", '{"attrs":" title=\\"A `value`\\" ","body":""}'],
    [
      '<Chart title="A `value`">{"label":"`value`"}</Chart>',
      "chart",
      '{"attrs":" title=\\"A `value`\\"","body":"{\\"label\\":\\"`value`\\"}"}',
    ],
  ])("restores literal data in the %s publishing payload", (source, kind, payload) => {
    const document = parseDocsDocument(source);
    const token = document.tokens.find(
      (entry) => entry.type === "inline" && entry.content.startsWith(`${markerPrefix}:${kind}:`),
    );
    const encoded = token?.content.split(":")[2];
    assert.isDefined(encoded);
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(payload);
  });

  it("keeps placeholder-shaped author text and component examples literal", () => {
    const source = [
      "```md",
      '<Accordion title="Do not render `this`" id="example">',
      "OPENCLAWVERBATIM0END $&",
      "{/* retain this comment */}",
      "</Accordion>",
      "```",
      "",
      '`<Badge id="inline-example" />`',
      "",
      '<Accordion title="Keep `OPENCLAWVERBATIM0END $&` and `status=timeout`">',
      "Visible body.",
      "</Accordion>",
    ].join("\n");
    const document = parseDocsDocument(source);
    expect(document.tokens.find((token) => token.type === "fence")?.content).toBe(
      '<Accordion title="Do not render `this`" id="example">\nOPENCLAWVERBATIM0END $&\n{/* retain this comment */}\n</Accordion>\n',
    );
    expect(document.ids).toEqual(["keep-openclawverbatim0end-and-and-status-timeout"]);
    expect(
      document.tokens
        .flatMap((token) => token.children ?? [])
        .find((token) => token.type === "code_inline")?.content,
    ).toBe('<Badge id="inline-example" />');
  });
});
