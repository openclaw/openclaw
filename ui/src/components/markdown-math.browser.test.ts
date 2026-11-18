import { describe, expect, it, vi } from "vitest";
import { createMarkdownParser } from "./markdown-parser.ts";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const parser = createMarkdownParser();

describe("explicit Markdown math", () => {
  it("keeps display math intact across blank lines and appended closing-line prose", () => {
    const equation = String.raw`\[
a=1

b=2
\]`;
    for (const [key, source] of [
      ["multiline-math", equation],
      ["same-line-math", "$$x$$ plus text"],
      ["math-paragraph", "$$x$$ and a\nb"],
      ["quoted-math", "> $$x$$\n> more"],
      ["quoted-multiline-math", "> \\[\n> x\n>\n> y\n> \\]\n> more"],
    ] as const) {
      expect(toStreamingMarkdownParts(source).join("")).toBe(toSanitizedMarkdownHtml(source));
      for (let i = 1; i <= source.length; i++) {
        toStreamingMarkdownParts(source.slice(0, i), {}, key);
      }
      expect(toStreamingMarkdownParts(source, {}, key).join("")).toBe(
        toSanitizedMarkdownHtml(source),
      );
    }
  });

  it("upgrades sanitized Markdown outside transcript block owners", async () => {
    const root = htmlFragment(toSanitizedMarkdownHtml(String.raw`\(x^2\)`));
    document.body.append(root);
    try {
      await vi.waitFor(() =>
        expect(
          root
            .querySelector("openclaw-math")
            ?.firstElementChild?.shadowRoot?.querySelector(".katex"),
        ).toBeTruthy(),
      );
    } finally {
      root.remove();
    }
  });

  it("preserves equations through both static and streaming sanitization", () => {
    const source =
      String.raw`Inline \(x_i^2\).

\[
G_{\rm eff}>G

E=mc^2
\]

Code: ` + "`\\(literal\\)`";
    for (const html of [
      toSanitizedMarkdownHtml(source),
      toStreamingMarkdownParts(source, {}, "math-regression").join(""),
    ] as const) {
      const root = htmlFragment(html);
      expect(
        [...root.querySelectorAll(".markdown-math")].map((node) => node.textContent?.trim()),
      ).toEqual([
        "x_i^2",
        String.raw`G_{\rm eff}>G

E=mc^2`,
      ]);
      expect(root.querySelector("code")?.textContent).toBe(String.raw`\(literal\)`);
    }
  });

  it("preserves aligned display source and inline TeX before Markdown escapes", () => {
    const aligned = String.raw`\begin{aligned}
G_{\rm eff} &> G \\
\Delta\Gamma &= \frac{d\ln M}{d\ln a}
\end{aligned}`;
    const tokens = parser.parse(`\\[\n${aligned}\n\\]\n\nInline \\(x_i^2\\).`, {});
    expect(tokens[0]?.type).toBe("math_block");
    expect(tokens[0]?.content.trim()).toBe(aligned);
    expect(
      tokens
        .find((token) => token.type === "inline")
        ?.children?.find((token) => token.type === "math_inline")?.content,
    ).toBe("x_i^2");
    expect(parser.render("$$E=mc^2$$")).toContain('class="markdown-math');
  });

  it("keeps prices, inline code, fences and indented code literal", () => {
    const source = "Prices $5 and $10. `\\(code\\)`\n\n```tex\n$$code$$\n```\n\n    \\[code\\]";
    const html = parser.render(source);
    expect(html).not.toContain("markdown-math");
    expect(html).toContain("Prices $5 and $10.");
    expect(html).toContain("<code>\\(code\\)</code>");
    expect(html).toContain("$$code$$");
    expect(html).toContain("\\[code\\]");
  });

  it("does not close TeX on escaped delimiters or turn source into HTML", () => {
    for (const source of [
      String.raw`\(a \\) + b\)`,
      String.raw`\[a \\] + b\]`,
      String.raw`$$a\$$$`,
    ] as const) {
      const html = parser.render(source);
      expect(html.match(/class="markdown-math/g)).toHaveLength(1);
      expect(html).not.toMatch(/<\/openclaw-math>[^<]*[)\]]/u);
    }
    const html = parser.render(String.raw`\(<img src=x onerror=alert(1)>\)`);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(parser.render(String.raw`\(unfinished`)).not.toContain("markdown-math");
  });
});
