import type { MarkdownIt } from "markdown-it";

export function installMarkdownHeadings(parser: MarkdownIt): void {
  parser.core.ruler.after("inline", "document-headings", (state) => {
    // Only file readers provide a document path; passive documents retain their markup.
    if (state.env?.mode !== "document" || !state.env.fileLinkBasePath) {
      return;
    }
    const used = new Set<string>();
    for (const [index, token] of state.tokens.entries()) {
      if (token.type !== "heading_open") {
        continue;
      }
      const text = (state.tokens[index + 1]?.children ?? [])
        .filter((child) => child.type === "text" || child.type === "code_inline")
        .map((child) => child.content)
        .join("");
      const slug = text
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, "")
        .replace(/\s/g, "-");
      let unique = slug;
      for (let suffix = 1; used.has(unique); suffix++) {
        unique = slug + "-" + suffix;
      }
      used.add(unique);
      token.attrSet("data-markdown-heading", unique);
    }
  });
}

/** The Markdown island owns its headings, independently of page/session routing. */
export function scrollMarkdownToFragment(article: HTMLElement, fragment: string): void {
  if (!fragment) {
    article.parentElement?.scrollTo({ top: 0 });
    return;
  }
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof HTMLElement && node.dataset.markdownHeading === fragment) {
      node.scrollIntoView({ block: "start" });
      return;
    }
  }
}
