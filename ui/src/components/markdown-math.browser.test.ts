import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const leafTag = "openclaw-markdown-math";

function mount(markdown: string, options = {}) {
  const host = document.createElement("article");
  host.innerHTML = toSanitizedMarkdownHtml(markdown, options);
  document.body.append(host);
  return host;
}

function typeset(host: HTMLElement): Promise<void> {
  if (host.querySelector(".katex")) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (host.querySelector(".katex")) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(host, { childList: true, subtree: true });
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Control UI lazy LaTeX rendering", () => {
  it("automatically typesets completed cached snapshots on every Markdown surface", async () => {
    const source = "Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$";
    const cached = toSanitizedMarkdownHtml(source);
    expect(cached).not.toContain('class="katex"');
    for (const options of [{}, { mode: "document" as const }, { progressBars: true }]) {
      const host = mount(source, options);
      await typeset(host);
      expect(host.querySelectorAll(".katex")).toHaveLength(2);
      const inline = host.querySelector<HTMLElement>(".katex")!;
      expect(inline.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(getComputedStyle(inline).fontFamily).toContain("KaTeX_Main");
      expect(host.querySelector(".katex-display math")).not.toBeNull();
      expect(host.querySelector("a")).toBeNull();
    }
    expect(toSanitizedMarkdownHtml(source)).toBe(cached);
  });

  it("styles math in shadow-root document previews before committing output", async () => {
    const shell = document.createElement("section");
    const root = shell.attachShadow({ mode: "open" });
    const host = document.createElement("article");
    host.innerHTML = toSanitizedMarkdownHtml("$x^2$", { mode: "document" });
    root.append(host);
    document.body.append(shell);
    await typeset(host);
    expect(getComputedStyle(host.querySelector(".katex")!).fontFamily).toContain("KaTeX_Main");
    expect(root.adoptedStyleSheets).toHaveLength(1);
  });

  it("does not enqueue code, currency, URLs, or unfinished streamed math", () => {
    const source = "Prices $5-$10 and $20. `$x$` https://example.com/$schema$ \\(unfinished";
    expect(mount(source).querySelector(leafTag)).toBeNull();
    const host = document.createElement("article");
    host.innerHTML = toStreamingMarkdownParts("before\n\n$$\nx^2", {}, "lazy-incomplete").join("");
    document.body.append(host);
    expect(host.querySelector(leafTag)).toBeNull();
  });

  it("does not commit to disposed leaves and resumes retained DOM on connection", async () => {
    const retired = mount("$retired$");
    retired.remove();
    const current = mount("$current$");
    await typeset(current);
    expect(retired.querySelector(".katex")).toBeNull();
    document.body.append(retired);
    await typeset(retired);
    const rendered = retired.querySelector(".katex");
    retired.remove();
    document.body.append(retired);
    expect(retired.querySelector(".katex")).toBe(rendered);
  });
  it("keeps wide display math keyboard-focusable and both ends reachable", async () => {
    const source =
      "$$" + Array.from({ length: 35 }, (_, index) => "x_{" + index + "}").join("+") + "$$";
    const host = mount(source);
    host.style.width = "180px";
    await typeset(host);
    const leaf = host.querySelector<HTMLElement>(leafTag)!;
    const scroller = [leaf, ...leaf.querySelectorAll<HTMLElement>("*")].find(
      (element) =>
        /^(auto|scroll)$/.test(getComputedStyle(element).overflowX) &&
        element.clientWidth > 0 &&
        element.scrollWidth > element.clientWidth,
    );
    expect(scroller, "wide math needs a local horizontal reading surface").toBeDefined();
    const readingSurface = scroller!;
    readingSurface.focus();
    expect(document.activeElement).toBe(readingSurface);
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => readingSurface.scrollLeft).toBeGreaterThan(0);
    expect(readingSurface.getBoundingClientRect().width).toBeLessThanOrEqual(180);
    const groups = leaf.querySelectorAll<HTMLElement>(".katex-html > .katex-base");
    expect(groups.length).toBeGreaterThan(0);
    readingSurface.scrollTo({ left: 0, behavior: "instant" });
    expect(groups[0]!.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      readingSurface.getBoundingClientRect().left - 1,
    );
    readingSurface.scrollLeft = readingSurface.scrollWidth;
    expect(readingSurface.scrollLeft).toBeGreaterThan(0);
    expect(groups[groups.length - 1]!.getBoundingClientRect().right).toBeLessThanOrEqual(
      readingSurface.getBoundingClientRect().right + 1,
    );
  });
  it("fades only the clipped edges of overflowing display math", async () => {
    const wide = mount("$$" + Array.from({ length: 35 }, (_, i) => `x_{${i}}`).join("+") + "$$");
    const short = mount("$$x^2$$");
    wide.style.width = short.style.width = "180px";
    await Promise.all([typeset(wide), typeset(short)]);
    const leaf = wide.querySelector<HTMLElement>(leafTag)!;
    const fade = () => getComputedStyle(leaf).maskImage;
    const frame = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    expect(getComputedStyle(short.querySelector(leafTag)!).maskImage).toBe("none");
    if (!CSS.supports("animation-timeline: scroll()")) {
      return;
    }
    await frame();
    const start = fade();
    expect(start).toContain("gradient");
    leaf.scrollLeft = leaf.scrollWidth;
    await frame();
    expect(fade()).toContain("gradient");
    expect(fade()).not.toBe(start);
    await userEvent.tab();
    expect(document.activeElement).toBe(leaf);
    expect(fade()).toBe("none");
  });
});
