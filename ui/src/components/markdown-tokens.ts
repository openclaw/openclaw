import DOMPurify from "dompurify";
import type { Token } from "markdown-it";
import { t } from "../i18n/index.ts";
import {
  markdownCodeBlockCopyText,
  markdownCodeBlockCopyAttributes,
  markdownCodeBlockLayout,
  markdownCodeClass,
  highlightCodeHtml,
} from "./markdown-code-blocks.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";
import { isMarkdownBlockArtText } from "./markdown-text.ts";

const tags = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "li",
  "ol",
  "p",
  "s",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const attrs = new Set([
  "class",
  "href",
  "title",
  "start",
  "role",
  "tabindex",
  "data-file-kind",
  "data-file-line",
  "data-file-path",
  "data-session-key",
  "data-session-href",
  "data-github-kind",
]);
let highlightSanitizer: ReturnType<typeof DOMPurify> | undefined;

/** Only allowlisted HTML nodes are created here. Authored HTML uses the full sanitizer. */
export function renderMarkdownTokens(
  tokens: Token[],
  env: MarkdownRenderEnv,
  attributePolicy: ReturnType<typeof DOMPurify>,
  decorateAnchor: (node: HTMLAnchorElement) => void,
): DocumentFragment | null {
  function element(
    tag: string,
    attributes: Record<string, string> = {},
    children: (Node | string)[] = [],
  ): HTMLElement {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (attributePolicy.isValidAttribute(tag, name, value.trim())) {
        node.setAttribute(name, value.trim());
      }
    }
    node.append(...children);
    return node;
  }

  function codeBlock(token: Token, open: boolean): HTMLElement {
    const lang = token.type === "fence" ? token.info.trim().split(/\s+/)[0] || "" : "";
    const highlighted = open ? null : highlightCodeHtml(token.content, lang);
    const code = element("code");
    const className = markdownCodeClass(lang, highlighted ?? "");
    if (className && attributePolicy.isValidAttribute("code", "class", className)) {
      code.className = className;
    }
    if (highlighted !== null) {
      // Syntax highlighting is generated HTML: preserve its existing sanitizer boundary.
      const fragment = (highlightSanitizer ??= DOMPurify(window)).sanitize(highlighted, {
        ALLOWED_TAGS: ["span"],
        ALLOWED_ATTR: ["class"],
        RETURN_DOM_FRAGMENT: true,
      });
      code.append(fragment);
    } else {
      code.textContent = token.content;
    }
    const pre = element("pre", {}, [code]);
    if (env.codeBlockChrome === "none" && env.codeBlockInteraction === "static") {
      return pre;
    }
    const interactive = env.codeBlockInteraction === "interactive";
    const { wrapperClass, hiddenLineCount: hidden } = markdownCodeBlockLayout(token.content, lang);
    const wrapper = element("div", {
      class: `${wrapperClass}${interactive && hidden ? " is-collapsible" : ""}`,
    });
    const actions = element("div", { class: "code-block-actions" });
    if (interactive) {
      const label = t("chat.codeBlock.enableWrap");
      actions.append(
        element(
          "button",
          {
            type: "button",
            class: "code-block-wrap",
            "data-markdown-key": "wrap",
            "aria-label": label,
            title: label,
            "aria-pressed": "false",
          },
          [element("span", { class: "code-block-wrap__icon", "aria-hidden": "true" })],
        ),
      );
    }
    if (env.codeBlockChrome !== "none") {
      actions.append(
        element(
          "button",
          {
            type: "button",
            class: "code-block-copy",
            "data-markdown-key": "copy",
            ...markdownCodeBlockCopyAttributes(markdownCodeBlockCopyText(token.content)),
            "aria-label": t("common.copyCode"),
          },
          [
            element("span", { class: "code-block-copy__idle", "aria-hidden": "true" }),
            element("span", { class: "code-block-copy__done", "aria-hidden": "true" }),
            element("span", { class: "code-block-copy__failed", "aria-hidden": "true" }, ["!"]),
          ],
        ),
      );
    }
    wrapper.append(
      element("div", { class: "code-block-header", "data-markdown-key": "header" }, [
        element("span", { class: "code-block-lang" }, [
          lang || t("chat.codeBlock.languageFallback"),
        ]),
        actions,
      ]),
    );
    wrapper.append(
      interactive
        ? element("div", { class: "code-block-viewport", "data-markdown-key": "viewport" }, [pre])
        : pre,
    );
    if (interactive && hidden) {
      wrapper.append(
        element(
          "button",
          {
            type: "button",
            class: "code-block-expand",
            "data-markdown-key": "expand",
            "aria-label": t(
              hidden === 1 ? "chat.codeBlock.showHiddenLine" : "chat.codeBlock.showHiddenLines",
              { count: String(hidden) },
            ),
            "aria-expanded": "false",
          },
          [
            element("span", { class: "code-block-chevron", "aria-hidden": "true" }),
            element("span", {}, [
              t(hidden === 1 ? "chat.codeBlock.hiddenLine" : "chat.codeBlock.hiddenLines", {
                count: String(hidden),
              }),
            ]),
          ],
        ),
      );
    }
    return wrapper;
  }

  if (env.progressBars || env.humanMentions.length) {
    return null;
  }
  // Unsupported plugin tokens and raw HTML keep the existing whole-render boundary.
  const supported = (list: Token[]): boolean =>
    list.every((token) => {
      if (token.children && !supported(token.children)) {
        return false;
      }
      // HTML parsing normalizes these bytes after plugins decode file paths.
      if (token.attrs?.some(([, value]) => /[\0\r]/u.test(String(value)))) {
        return false;
      }
      const href = token.attrGet("href");
      if (href && !URL.parse(String(href), document.baseURI)) {
        return false;
      }
      if (token.type === "fence" || token.type === "code_block") {
        const lang = token.type === "fence" ? token.info.trim().split(/\s+/)[0]?.toLowerCase() : "";
        return (
          !isMarkdownBlockArtText(token.content) &&
          lang !== "mermaid" &&
          !(env.codeBlockInteraction === "interactive" && (!lang || lang === "json"))
        );
      }
      if (
        ["inline", "text", "code_inline", "softbreak", "hardbreak", "link_favicon"].includes(
          token.type,
        )
      ) {
        return true;
      }
      if (token.type === "html_inline" && token.meta?.taskListPlugin === true) {
        return true;
      }
      if (!tags.has(token.tag)) {
        return false;
      }
      return true;
    });
  if (!supported(tokens)) {
    return null;
  }
  const root = document.createDocumentFragment();
  const stack: ParentNode[] = [root];
  const render = (list: Token[]) => {
    for (let index = 0; index < list.length; index++) {
      const token = list[index]!;
      let parent = stack.at(-1)!;
      if (token.hidden) {
        continue;
      }
      if (token.type === "inline") {
        render(token.children || []);
        continue;
      }
      if (token.type === "text") {
        parent.append(
          document.createTextNode(token.content.replaceAll("\0", "").replace(/\r\n?/gu, "\n")),
        );
        continue;
      }
      if (token.type === "code_inline") {
        parent.append(
          element("code", {}, [token.content.replaceAll("\0", "").replace(/\r\n?/gu, "\n")]),
        );
        continue;
      }
      if (token.type === "link_favicon") {
        const hostname: unknown = token.meta?.hostname;
        if (typeof hostname === "string") {
          parent.append(
            element("img", {
              class: "markdown-link-favicon",
              "data-link-favicon-host": hostname,
              alt: "",
              role: "presentation",
            }),
          );
        }
        continue;
      }
      if (token.type === "softbreak" || token.type === "hardbreak") {
        parent.append(element("br"), "\n");
        continue;
      }
      if (token.type === "html_inline") {
        parent.append(
          element("input", {
            class: "task-list-item-checkbox",
            ...(token.content.includes("checked") ? { checked: "" } : {}),
            disabled: "",
            type: "checkbox",
          }),
        );
        continue;
      }
      if (token.type === "fence" || token.type === "code_block") {
        const open =
          token.type === "fence" &&
          env.streamingOpenFence === true &&
          list.findLastIndex((item) => item.nesting !== -1) === index;
        parent.append(codeBlock(token, open));
        continue;
      }
      if (token.nesting === -1) {
        if (parent instanceof HTMLAnchorElement) {
          decorateAnchor(parent);
        }
        stack.pop();
        parent = stack.at(-1)!;
        if (token.type === "table_close" && env.tableInteractions === "enabled") {
          stack.pop();
          const shell = stack.pop()!;
          shell.append(
            element("div", { class: "markdown-table__actions" }, [
              element("button", {
                type: "button",
                class: "markdown-table__expand",
                "aria-label": t("common.expandTable"),
              }),
              element("button", {
                type: "button",
                class: "markdown-table__copy",
                "aria-label": t("common.copyTable"),
              }),
            ]),
          );
        } else if (token.block) {
          parent.append("\n");
        }
        continue;
      }
      if (token.type === "table_open" && env.tableInteractions === "enabled") {
        const shell = element("div", { class: "markdown-table", "data-table-interactions": "" });
        const viewport = element("div", { class: "markdown-table__viewport" });
        shell.append(viewport);
        parent.append(shell);
        stack.push(shell, viewport);
        parent = viewport;
      }
      if (token.block && token.type !== "table_open") {
        let previous = index - 1;
        while (previous >= 0 && list[previous]!.hidden && list[previous]!.nesting === 0) {
          previous--;
        }
        if (previous >= 0 && list[previous]!.hidden && list[previous]!.nesting === -1) {
          parent.append("\n");
        }
      }
      const node = element(token.tag);
      for (const [name, value] of token.attrs || []) {
        if (
          !attrs.has(name) ||
          !attributePolicy.isValidAttribute(token.tag, name, String(value).trim())
        ) {
          continue;
        }
        const normalized = String(value).trim();
        if (name === "href") {
          const url = URL.parse(normalized, document.baseURI);
          if (!url || !["http:", "https:", "mailto:"].includes(url.protocol)) {
            continue;
          }
        }
        node.setAttribute(name, normalized);
      }
      parent.append(node);
      if (token.nesting === 1) {
        stack.push(node);
      }
      if (
        token.block &&
        !(token.type === "table_open" && env.tableInteractions === "enabled") &&
        !(token.nesting === 1 && list[index + 1]?.type === "inline")
      ) {
        // markdown-it suppresses line breaks inside tight lists.
        const next = list[index + 1];
        if (!(next?.hidden || (next?.nesting === -1 && next.tag === token.tag))) {
          stack.at(-1)!.append("\n");
        }
      }
    }
  };
  render(tokens);
  return root;
}
