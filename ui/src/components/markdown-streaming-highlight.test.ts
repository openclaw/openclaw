import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("toStreamingMarkdownParts code fences", () => {
  it("streams an open code fence without syntax highlighting", () => {
    const html = toStreamingMarkdownParts("Intro\n\n```ts\nconst x = 1 < 2").join("");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("code.language-ts");

    expect(fragment.querySelector("p")?.textContent).toBe("Intro");
    expect(code?.textContent).toContain("const x = 1 < 2");
    expect(code?.classList.contains("hljs")).toBe(false);
    expect(code?.querySelector("span")).toBeNull();
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("keeps a completed fence highlighted when a later backtick fence has invalid info", () => {
    const html = toStreamingMarkdownParts(
      "- ```ts\n  const closed = 1;\n  ```\n\n  ```bad`info\n  trailing text",
    ).join("");
    const code = htmlFragment(html).querySelector("code.language-ts");

    expect(code?.textContent).toContain("const closed = 1;");
    expect(code?.classList.contains("hljs")).toBe(true);
  });

  it("renders a completed code fence once the closing fence arrives", () => {
    const markdown = "```ts\nconst x = 1;\n```";
    const html = toStreamingMarkdownParts(markdown).join("");

    expect(html).toContain('<code class="hljs language-ts"');
    expect(html).toContain("const x = 1;");
    expect(html).not.toContain("markdown-plain-text-fallback");
    expect(html).toBe(toSanitizedMarkdownHtml(markdown));
  });
});
