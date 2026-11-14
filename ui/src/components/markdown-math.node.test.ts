// @vitest-environment node
import MarkdownIt from "markdown-it";
import { expect, it } from "vitest";
import { installMarkdownMath } from "./markdown-math.ts";

it("parses readable math without requiring browser custom elements", () => {
  expect(typeof globalThis.HTMLElement).toBe("undefined");
  expect(typeof globalThis.customElements).toBe("undefined");
  const parser = new MarkdownIt();
  installMarkdownMath(parser);
  const html = parser.render("Inline $x$.\n\n$$x^2$$");
  expect(html).toContain('data-display="false">$x$</openclaw-markdown-math>');
  expect(html).toContain('data-display="true" tabindex="0">$$x^2$$</openclaw-markdown-math>');
  expect(html).not.toContain('class="katex"');
});
