import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { pathForTemplateCatalogEntry } from "../app-route-paths.ts";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const path = pathForTemplateCatalogEntry("@steipete/peterbot");
afterEach(() => {
  document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
});
describe("inline Template recommendations", () => {
  it("renders named local catalog links as inline references in settled and streaming chat", () => {
    const source = `I’d start with [Peterbot](${path}).`;
    for (const html of [
      toSanitizedMarkdownHtml(source, { sessionLinks: true }),
      toStreamingMarkdownParts(source, { sessionLinks: true }).join(""),
    ]) {
      const fragment = htmlFragment(html);
      const anchor = fragment.querySelector("a.markdown-template-link");
      expect(anchor?.textContent).toBe("Peterbot");
      expect(anchor?.getAttribute("data-template-package")).toBe("@steipete/peterbot");
      expect(anchor?.getAttribute("href")).toBe(path);
      expect(anchor?.getAttribute("aria-haspopup")).toBe("dialog");
      expect(anchor?.classList.contains("markdown-file-link")).toBe(false);
    }
  });
  it("does not claim external/lookalike URLs, code or non-chat Markdown", () => {
    for (const href of [
      `https://example.com${path}`,
      `${path}?install=true`,
      `${path}#other`,
      "/templates/packages/%40steipete%2F..",
    ]) {
      const html = toSanitizedMarkdownHtml(`[Template](${href})`, { sessionLinks: true });
      expect(htmlFragment(html).querySelector("a.markdown-template-link")).toBeNull();
    }
    expect(
      toSanitizedMarkdownHtml(`\`[Peterbot](${path})\``, { sessionLinks: true }),
    ).not.toContain('class="markdown-template-link"');
    expect(toSanitizedMarkdownHtml(`[Peterbot](${path})`)).not.toContain(
      'class="markdown-template-link"',
    );
  });
  it("uses the active Control UI base path", () => {
    document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "/work");
    for (const [base, expected] of [
      ["/work", "@steipete/peterbot"],
      ["/other", null],
    ]) {
      const html = toSanitizedMarkdownHtml(`[Template](${base}${path})`, { sessionLinks: true });
      expect(
        htmlFragment(html)
          .querySelector("a.markdown-template-link")
          ?.getAttribute("data-template-package") ?? null,
      ).toBe(expected);
    }
  });
});
