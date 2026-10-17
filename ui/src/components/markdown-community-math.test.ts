import { describe, expect, it } from "vitest";
import { renderMarkdownMath } from "./markdown-math.runtime.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
describe("LaTeX", () => {
  it.each([
    ["$x^2$", false],
    ["\\(x^2\\)", false],
    ["$$x^2$$", true],
    ["\\[x^2\\]", true],
    ["$$\nx^2\n\n+ y^2\n$$", true],
    ["\\[\nx^2\n\n+ y^2\n\\]", true],
  ])("renders delimiter variant %j", (source, display) => {
    const fragment = mathFragment(toSanitizedMarkdownHtml(source));
    expect(fragment.querySelectorAll(".katex")).toHaveLength(1);
    expect(fragment.querySelector(".katex-display") !== null).toBe(display);
    expect(fragment.querySelector("math")).not.toBeNull();
  });

  it.each(["```tex\n$x^2$\n\\[y\\]\n```", "    $x^2$\n\n    \\(y\\)", "\\$x^2\\$"])(
    "does not interpret code or escaped delimiters: %j",
    (source) => {
      expect(mathFragment(toSanitizedMarkdownHtml(source)).querySelector(".katex")).toBeNull();
    },
  );

  it("renders inline and display math with KaTeX", () => {
    const fragment = mathFragment(
      toSanitizedMarkdownHtml("Inline $x^2$ and:\n\n$$\n\\frac{1}{2}\n$$"),
    );

    expect(fragment.querySelector(".katex")).not.toBeNull();
    expect(fragment.querySelector(".katex-display")).not.toBeNull();
    expect(fragment.textContent).toContain("x2");
  });

  it("keeps math-looking code literal", () => {
    const fragment = mathFragment(toSanitizedMarkdownHtml("`$x^2$` and `\\(y\\)`"));

    expect(fragment.querySelectorAll(".katex")).toHaveLength(0);
    expect(fragment.textContent?.trim()).toBe("$x^2$ and \\(y\\)");
  });

  it("does not allow KaTeX trust commands to create links", () => {
    const html = mathFragment(
      toSanitizedMarkdownHtml("$\\href{javascript:alert(1)}{x}$"),
    ).innerHTML;

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a");
  });

  it("preserves compact currency ranges and bare URL paths", () => {
    const html = toSanitizedMarkdownHtml(
      "Prices: $5-$10; docs: https://example.com/$schema$/query?$x$=1 and www.example.com/$path$/$next$/docs",
    );
    expect(html).toContain("$5-$10");
    expect(html).toContain("$schema$");
    expect(html).not.toContain("katex");
  });

  it("keeps distant multiline display closers literal", () => {
    const source = "\\[\n" + "x\n".repeat(2050) + "\\]";
    const fragment = mathFragment(toSanitizedMarkdownHtml(source));
    expect(fragment.querySelector(".katex")).toBeNull();
    expect(fragment.textContent).toContain("x");
  });

  it("escapes text when the math rendering budget is exhausted", () => {
    const input = Array.from({ length: 201 }, (_, index) => `$x_${index}$`).join(" ");
    const html = toSanitizedMarkdownHtml(`${input} $<img src=x onerror=alert(1)>$`);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(htmlFragment(html).querySelectorAll("openclaw-markdown-math")).toHaveLength(200);
    expect(
      htmlFragment(toSanitizedMarkdownHtml("$fresh$")).querySelectorAll("openclaw-markdown-math"),
    ).toHaveLength(1);
  });

  it("preserves currency prose and display-math suffixes", () => {
    const fragment = mathFragment(
      toSanitizedMarkdownHtml("Costs rose from $5 to $10. Result: $$x^2$$ and explanation."),
    );

    expect(fragment.textContent).toContain("Costs rose from $5 to $10.");
    expect(fragment.textContent).toContain("and explanation.");
    expect(fragment.querySelector(".katex-display")).not.toBeNull();
  });

  it("retains accessible MathML and KaTeX geometry", () => {
    const fragment = mathFragment(toSanitizedMarkdownHtml("$\\frac{1}{2}$"));

    expect(fragment.querySelector("math")).not.toBeNull();
    expect(fragment.querySelector(".katex-html[aria-hidden='true']")).not.toBeNull();
    expect(fragment.querySelector(".strut[style]")).not.toBeNull();
  });

  it("preserves text conditions in the sanitized accessible MathML", () => {
    const fragment = mathFragment(toSanitizedMarkdownHtml(String.raw`$x + \text{otherwise}$`));
    expect(fragment.querySelector(".katex-mathml math mtext")?.textContent).toBe("otherwise");
    expect(fragment.querySelector(".katex-html[aria-hidden='true']")).not.toBeNull();
  });

  it.each([
    [String.raw`$\mathbb{R}$`, "double-struck"],
    [String.raw`$\mathbf{x}$`, "bold"],
  ])("preserves the accessible symbol variant for %s", (source, variant) => {
    const math = mathFragment(toSanitizedMarkdownHtml(source)).querySelector(".katex-mathml math");
    expect(math?.querySelector("mi")?.getAttribute("mathvariant")).toBe(variant);
  });

  it("preserves a binomial's barless fraction and delimiter semantics", () => {
    const math = mathFragment(toSanitizedMarkdownHtml(String.raw`$\binom{n}{k}$`)).querySelector(
      ".katex-mathml math",
    );
    expect(math?.querySelector("mfrac")?.getAttribute("linethickness")).toBe("0px");
    expect([...math!.querySelectorAll('mo[fence="true"]')].map((node) => node.textContent)).toEqual(
      ["(", ")"],
    );
  });

  it("keeps authored MathML and active content literal", () => {
    const fragment = mathFragment(
      toSanitizedMarkdownHtml(
        '<math><mtext onclick="alert(1)"><img src=x onerror="alert(1)"></mtext></math>',
      ),
    );
    expect(fragment.querySelector("math, mtext, img, [onclick], [onerror]")).toBeNull();
    expect(fragment.textContent).toContain("<math><mtext");
  });

  it("escapes authored HTML instead of granting KaTeX geometry styles", () => {
    const fragment = mathFragment(
      toSanitizedMarkdownHtml(
        '<a href="https://example.com" style="position:fixed;inset:0;z-index:9999">fake</a>',
      ),
    );
    expect(fragment.querySelector("a")).toBeNull();
    expect(fragment.querySelector("[style]")).toBeNull();
    expect(fragment.textContent).toContain("<a href=");
  });

  it("does not preserve authored progress styles", () => {
    const fragment = mathFragment(
      toSanitizedMarkdownHtml(
        '<progress value="1" max="2" style="position:fixed;inset:0"></progress>',
        {
          progressBars: true,
        },
      ),
    );
    expect(fragment.querySelector("progress")?.hasAttribute("style")).toBe(false);
  });

  it("supports math inside link labels during silent lookahead", () => {
    const fragment = mathFragment(toSanitizedMarkdownHtml("[$x$](https://example.com)"));

    expect(fragment.querySelector("a .katex")).not.toBeNull();
  });
});

// Exercise the real lazy runtime's sanitizer without connecting DOM or fetching it
// from the parser. Lifecycle/network admission has separate browser coverage.
function mathFragment(html: string): HTMLElement {
  const host = htmlFragment(html);
  for (const leaf of host.querySelectorAll<HTMLElement>("openclaw-markdown-math")) {
    const display = leaf.dataset.display === "true";
    const length = display ? 2 : 1;
    leaf.replaceChildren(
      renderMarkdownMath((leaf.textContent ?? "").slice(length, -length), display),
    );
  }
  return host;
}
