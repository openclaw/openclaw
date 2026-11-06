import type { MarkdownIt } from "markdown-it";
import { templateCatalogPackageNameFromPath } from "../app-route-paths.ts";
import { resolveControlUiPaths } from "../app/browser.ts";
import { markdownInlineChildren } from "./markdown-text-replacements.ts";

/** Local catalog links retain a useful route when opened outside the chat surface. */
export function markdownTemplatePackage(raw: string, basePath?: string): string | null {
  const location = globalThis.location;
  if (!location) {
    return null;
  }
  const url = URL.parse(raw, location.href);
  if (!url || url.origin !== location.origin || url.search || url.hash) {
    return null;
  }
  return templateCatalogPackageNameFromPath(
    url.pathname,
    basePath ?? resolveControlUiPaths(location.pathname)[0],
  );
}

export function installMarkdownTemplateLinks(parser: MarkdownIt) {
  parser.core.ruler.before("file-links", "template-links", (state) => {
    if (state.env?.sessionLinks !== true) {
      return;
    }
    for (const children of markdownInlineChildren(state.tokens)) {
      for (const token of children) {
        if (token.type !== "link_open") {
          continue;
        }
        const name = markdownTemplatePackage(String(token.attrGet("href") ?? ""));
        if (!name) {
          continue;
        }
        token.attrJoin("class", "markdown-template-link");
        token.attrSet("data-template-package", name);
        token.attrSet("aria-haspopup", "dialog");
      }
    }
  });
}
