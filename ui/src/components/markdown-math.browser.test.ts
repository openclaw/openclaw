import { afterEach, describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("Control UI LaTeX rendering", () => {
  it("renders visible inline and display equations in Chromium", () => {
    const host = document.createElement("article");
    host.innerHTML = toSanitizedMarkdownHtml(
      "Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$",
    );
    document.body.append(host);

    const inline = host.querySelector<HTMLElement>(".katex");
    const display = host.querySelector<HTMLElement>(".katex-display");
    expect(inline).not.toBeNull();
    expect(display).not.toBeNull();
    expect(inline!.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(display!.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("Euler:");
  });
});
