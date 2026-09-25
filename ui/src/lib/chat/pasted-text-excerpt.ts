import type { Token } from "markdown-it";
import { createMarkdownParser } from "../../components/markdown-parser.ts";
import { escapeMarkdownHtml } from "../../components/markdown-text.ts";
import { takeGraphemes } from "../graphemes.ts";

const parser = createMarkdownParser();

function htmlText(value: string): string {
  // Template contents stay inert: pasted elements never enter the document.
  const template = document.createElement("template");
  template.innerHTML = value;
  template.content
    .querySelectorAll("script, style, template")
    .forEach((element) => element.remove());
  template.content
    .querySelectorAll("p, div, br, hr, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre")
    .forEach((element) => element.after(document.createTextNode("\n")));
  return template.content.textContent ?? "";
}

function inlineText(tokens: readonly Token[]): string {
  const html = tokens
    .map((token) => {
      if (token.type === "text" || token.type === "code_inline") {
        return escapeMarkdownHtml(token.content);
      }
      if (token.type === "html_inline") {
        return token.content;
      }
      if (token.type === "image") {
        return escapeMarkdownHtml(inlineText(token.children ?? []));
      }
      return token.type === "softbreak" || token.type === "hardbreak" ? " " : "";
    })
    .join("");
  return htmlText(html);
}

function blockText(tokens: readonly Token[], flattenHtml = true): string {
  return tokens
    .map((token) => {
      if (token.type === "inline") {
        return inlineText(token.children ?? []);
      }
      if (token.type === "code_block" || token.type === "fence") {
        return token.content;
      }
      if (token.type === "html_block") {
        const text = htmlText(token.content);
        return flattenHtml ? blockText(parser.parse(text, {}), false) : text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

export function derivePastedTextExcerpt(text: string): string {
  const plainText = blockText(parser.parse(text, {})).replace(/\s+/gu, " ").trim();
  const excerpt = takeGraphemes(plainText, 30);
  return excerpt.length < plainText.length ? `${excerpt}…` : excerpt;
}
