import type { MarkdownIt, Token } from "markdown-it";
import { t } from "../i18n/index.ts";
import { formatGitHubItemReference, parseGitHubLinkTarget } from "./github-link-target.ts";

const VISIBLE_SOURCES = 5;

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
    const tag = (name: string, nesting: -1 | 1, className?: string) => {
      const token = new state.Token(`${name}_${nesting === 1 ? "open" : "close"}`, name, nesting);
      token.block = true;
      if (className) {
        token.attrSet("class", className);
      }
      result.push(token);
    };
    tag("div", 1, "markdown-source-footer");
    links.forEach((source, index) => {
      let link = source;
      if (index === VISIBLE_SOURCES) {
        tag("details", 1, "markdown-source-footer__more");
        tag("summary", 1);
        const label = new state.Token("text", "", 0);
        label.content = `${t("chat.messages.showMore")} (${links.length - VISIBLE_SOURCES})`;
        result.push(label);
        tag("summary", -1);
      }
      const target = targets[index];
      if (links.length > 3 && target) {
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
        link = [anchor, label, link.at(-1)!];
      }
      tag("div", 1, "markdown-source-footer__row");
      const row = new state.Token("inline", "", 0);
      row.children = link;
      result.push(row);
      tag("div", -1);
    });
    if (links.length > VISIBLE_SOURCES) {
      tag("details", -1);
    }
    tag("div", -1);
    state.tokens.splice(start, 3, ...result);
  });
}
