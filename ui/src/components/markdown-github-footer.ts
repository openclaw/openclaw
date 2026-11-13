import type { MarkdownIt, Token } from "markdown-it";
import { formatGitHubItemReference, parseGitHubLinkTarget } from "./github-link-target.ts";

/** Only a trailing, top-level link-only paragraph is a source footer, never prose. */
export function installMarkdownGitHubFooter(parser: MarkdownIt): void {
  parser.core.ruler.after("text_join", "github-source-footer", (state) => {
    const start = state.tokens.length - 3;
    const [open, inline, close] = state.tokens.slice(start);
    if (
      state.env.mode !== "message" ||
      open?.type !== "paragraph_open" ||
      open.level !== 0 ||
      inline?.type !== "inline" ||
      close?.type !== "paragraph_close"
    ) {
      return;
    }
    const links: Token[][] = [];
    const children = inline.children ?? [];
    for (let index = 0; index < children.length; index++) {
      const token = children[index]!;
      if (
        token.type === "softbreak" ||
        token.type === "hardbreak" ||
        (token.type === "text" && /^[\s,·]*$/u.test(token.content))
      ) {
        continue;
      }
      if (token.type !== "link_open") {
        return;
      }
      let end = index + 1;
      while (end < children.length && children[end]!.type !== "link_close") {
        end++;
      }
      if (
        end === children.length ||
        children.slice(index + 1, end).some((child) => child.type === "image")
      ) {
        return;
      }
      links.push(children.slice(index, end + 1));
      index = end;
    }
    const targets = links.map((link) =>
      parseGitHubLinkTarget(String(link[0]!.attrGet("href") ?? "")),
    );
    if (targets.filter(Boolean).length < 2) {
      return;
    }
    const repositories = new Set(
      targets.flatMap((target) => (target ? [`${target.owner}/${target.repo}`.toLowerCase()] : [])),
    );
    const result: Token[] = [];
    open.attrJoin("class", "markdown-source-footer");
    links.forEach((link, index) => {
      if (index > 0) {
        const separator = new state.Token("text", "", 0);
        separator.content = ", ";
        result.push(separator);
      }
      const target = targets[index];
      if (links.length >= 5 && target) {
        const anchor = link[0]!;
        const title = link
          .slice(1, -1)
          .map((token) => token.content)
          .join("");
        const label = new state.Token("text", "", 0);
        label.content =
          repositories.size === 1 ? `#${target.number}` : formatGitHubItemReference(target);
        anchor.attrJoin("class", "markdown-github-item");
        anchor.attrSet("data-github-kind", target.kind);
        anchor.attrSet("aria-label", `${label.content}: ${title}`);
        anchor.attrSet("title", title);
        result.push(anchor, label, link.at(-1)!);
      } else {
        result.push(...link);
      }
    });
    inline.children = result;
  });
}
