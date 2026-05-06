import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "../markdown.js";
import { resolveCodeBlockCopyText } from "./code-block-copy.ts";

function renderToContainer(markdown: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = toSanitizedMarkdownHtml(markdown);
  return container;
}

describe("resolveCodeBlockCopyText (#69605)", () => {
  it("returns the rendered code only, not surrounding prose", () => {
    const md = [
      "Here is some prose.",
      "",
      "```js",
      "function hello() {",
      '  return "world";',
      "}",
      "```",
      "",
      "And more prose.",
    ].join("\n");
    const container = renderToContainer(md);
    const btn = container.querySelector(".code-block-copy");

    const text = resolveCodeBlockCopyText(btn);

    expect(text).not.toContain("Here is some prose");
    expect(text).not.toContain("And more prose");
    expect(text).toContain("function hello()");
    expect(text).toContain('return "world"');
  });

  it("handles a click that lands on the inner Copy label span", () => {
    const md = "before\n\n```\nthe-only-code\n```\n\nafter";
    const container = renderToContainer(md);
    const innerLabel = container.querySelector(".code-block-copy__idle");
    expect(innerLabel).not.toBeNull();

    // Simulate the bubble-target search the click handler performs.
    const btn = innerLabel?.closest(".code-block-copy") as HTMLElement | null;
    expect(btn).not.toBeNull();

    const text = resolveCodeBlockCopyText(btn);
    expect(text.trim()).toBe("the-only-code");
  });

  it("returns each block's content when a message has multiple blocks", () => {
    const md = [
      "Intro.",
      "",
      "```js",
      "first()",
      "```",
      "",
      "Middle prose.",
      "",
      "```py",
      "second()",
      "```",
      "",
      "Outro.",
    ].join("\n");
    const container = renderToContainer(md);
    const buttons = Array.from(container.querySelectorAll(".code-block-copy"));
    expect(buttons).toHaveLength(2);

    expect(resolveCodeBlockCopyText(buttons[0]).trim()).toBe("first()");
    expect(resolveCodeBlockCopyText(buttons[1]).trim()).toBe("second()");
  });

  it("falls back to data-code when the wrapper has no rendered <code> element", () => {
    const button = document.createElement("button");
    button.className = "code-block-copy";
    button.dataset.code = "fallback-text";

    expect(resolveCodeBlockCopyText(button)).toBe("fallback-text");
  });

  it("returns an empty string when the button is missing", () => {
    expect(resolveCodeBlockCopyText(null)).toBe("");
    expect(resolveCodeBlockCopyText(undefined)).toBe("");
  });

  it("preserves HTML-special characters in code (round-trips < > &)", () => {
    // Inside a fenced block, the source `&amp;` is literal user content, not
    // an HTML entity. textContent must round-trip those literal characters
    // exactly so what the user sees is what gets copied.
    const md = "before\n\n```html\n<div>x & y</div>\n```\n\nafter";
    const container = renderToContainer(md);
    const btn = container.querySelector(".code-block-copy");

    const text = resolveCodeBlockCopyText(btn);
    expect(text).toContain("<div>");
    expect(text).toContain("x & y");
    expect(text).toContain("</div>");
  });
});
