import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  RAW_TEXT_TAGS,
  readRawTextOpenTagName,
  findRawTextOpenTagStart,
  startsLikeHtmlTag,
  readTagToken,
  readRawTextBounds,
  skipRawTextElement,
} from "../../../packages/markdown-core/src/html-scanner.js";
import { stripInvisibleUnicode } from "../../infra/unicode-visibility.js";
import { decodeHtmlEntities } from "../../shared/html-entities.js";
import { readHtmlAttribute } from "./web-fetch-attributes.js";
import { sanitizeHtml } from "./web-fetch-visibility.js";

export type ExtractMode = "markdown" | "text";

const BLOCK_BREAK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "table",
  "tr",
  "ul",
  "ol",
]);
// Keep malformed nested markup from making end-of-document context unwind quadratic.
// web_fetch favors bounded, auditable text over preserving deep broken HTML structure.
const MAX_RENDER_CONTEXT_DEPTH = 32;

type RenderContext =
  | { kind: "root"; parts: string[] }
  | { kind: "title"; parts: string[] }
  | { kind: "anchor"; href: string | undefined; hasText: boolean; parts: string[] }
  | { kind: "heading"; level: number; parts: string[] }
  | { kind: "list-item"; parts: string[] };

function decodeEntities(value: string): string {
  // Display extraction historically accepted mixed-case &nbsp; and treats non-breaking spaces as
  // ordinary collapsible whitespace. Normalize it before the shared decoder to stay single-pass.
  return decodeHtmlEntities(value.replace(/&nbsp;/gi, "\u00a0")).replaceAll("\u00a0", " ");
}

function readAnchorHref(rawTag: string): string | undefined {
  const value = readHtmlAttribute(rawTag, "href", "render");
  return value === undefined ? undefined : decodeEntities(value);
}

function appendText(stack: RenderContext[], value: string): void {
  const context = stack[stack.length - 1];
  context?.parts.push(value);
  if (context?.kind === "anchor" && /\S/.test(value)) {
    context.hasText = true;
  }
}

function closeContext(
  context: RenderContext,
  parent: RenderContext,
  state: { title?: string },
): void {
  const label = normalizeWhitespace(context.parts.join(""));
  if (!label && context.kind !== "title" && !(context.kind === "anchor" && context.href)) {
    return;
  }
  if (context.kind === "title") {
    state.title ??= label || undefined;
    return;
  }
  if (parent.kind === "title") {
    parent.parts.push(label);
    return;
  }
  switch (context.kind) {
    case "root":
      return;
    case "anchor":
      parent.parts.push(
        context.href && label ? `[${label}](${context.href})` : label || context.href || "",
      );
      return;
    case "heading":
      if (parent.kind === "anchor") {
        parent.parts.push(label);
        parent.hasText ||= Boolean(label);
      } else {
        parent.parts.push(`\n${"#".repeat(context.level)} ${label}\n`);
      }
      return;
    case "list-item":
      if (parent.kind === "anchor") {
        parent.hasText ||= Boolean(label);
      }
      parent.parts.push(`\n- ${label}`);
  }
}

function closeTopContext(stack: RenderContext[], state: { title?: string }): void {
  const context = stack.pop()!;
  closeContext(context, stack[stack.length - 1]!, state);
}

function closeThroughContext(
  stack: RenderContext[],
  kind: RenderContext["kind"],
  state: { title?: string },
  requireAnchorText = false,
): boolean {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    const context = stack[i];
    if (context?.kind === kind) {
      if (requireAnchorText && context.kind === "anchor" && !context.hasText) {
        return false;
      }
      while (stack.length > i) {
        closeTopContext(stack, state);
      }
      return true;
    }
  }
  return false;
}

function pushContext(
  stack: RenderContext[],
  context: Exclude<RenderContext, { kind: "root" }>,
  state: { title?: string },
): void {
  while (stack.length >= MAX_RENDER_CONTEXT_DEPTH) {
    closeTopContext(stack, state);
  }
  stack.push(context);
}

export function htmlToMarkdown(html: string): { text: string; title?: string } {
  const root: RenderContext = { kind: "root", parts: [] };
  const stack: RenderContext[] = [root];
  const state: { title?: string } = {};

  for (let i = 0; i < html.length;) {
    const ch = html[i];
    if (ch !== "<") {
      const nextTag = html.indexOf("<", i);
      const end = nextTag === -1 ? html.length : nextTag;
      appendText(stack, decodeEntities(html.slice(i, end)));
      i = end;
      continue;
    }

    const rawTextTagName = readRawTextOpenTagName(html, i);
    if (rawTextTagName) {
      i = skipRawTextElement(html, i, rawTextTagName);
      continue;
    }

    if (!startsLikeHtmlTag(html, i)) {
      appendText(stack, "<");
      i += 1;
      continue;
    }

    const read = readTagToken(html, i);
    if (!read) {
      const rawTextStart = findRawTextOpenTagStart(html, i + 1, html.length);
      if (rawTextStart !== -1) {
        i = rawTextStart;
        continue;
      }
      break;
    }
    const { token, next } = read;
    i = next;
    if (!token) {
      continue;
    }

    const kind =
      token.name === "title"
        ? "title"
        : token.name === "a"
          ? "anchor"
          : /^h[1-6]$/.test(token.name)
            ? "heading"
            : token.name === "li"
              ? "list-item"
              : undefined;
    if (token.closing) {
      if (kind) {
        closeThroughContext(stack, kind, state);
      } else if (BLOCK_BREAK_TAGS.has(token.name)) {
        appendText(stack, "\n");
      }
      continue;
    }

    if (RAW_TEXT_TAGS.has(token.name)) {
      i = readRawTextBounds(html, token.name, i).end;
      continue;
    }
    if (BLOCK_BREAK_TAGS.has(token.name) && closeThroughContext(stack, "anchor", state, true)) {
      appendText(stack, " ");
    }
    if (token.name === "br" || token.name === "hr") {
      appendText(stack, "\n");
      continue;
    }
    if (!kind || token.selfClosing) {
      continue;
    }
    if (kind !== "title") {
      closeThroughContext(stack, "anchor", state, kind !== "anchor");
    }
    const context: Exclude<RenderContext, { kind: "root" }> =
      kind === "anchor"
        ? { kind, href: readAnchorHref(token.raw), hasText: false, parts: [] }
        : kind === "heading"
          ? { kind, level: Number.parseInt(token.name[1] ?? "1", 10), parts: [] }
          : { kind, parts: [] };
    pushContext(stack, context, state);
  }

  while (stack.length > 1) {
    closeTopContext(stack, state);
  }

  return {
    text: normalizeWhitespace(root.parts.join("")),
    title: state.title,
  };
}

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function markdownToText(markdown: string): string {
  const codeBlocks: string[] = [];
  let text = "";
  let pos = 0;
  while (pos < markdown.length) {
    const open = markdown.indexOf("```", pos);
    if (open === -1) {
      text += markdown.slice(pos).replaceAll("\0", "\0\0");
      break;
    }
    text += markdown.slice(pos, open).replaceAll("\0", "\0\0");
    const afterOpen = open + 3;
    const close = markdown.indexOf("```", afterOpen);
    if (close === -1) {
      text += markdown.slice(open).replaceAll("\0", "\0\0");
      break;
    }
    const firstLineEnd = markdown.indexOf("\n", afterOpen);
    const contentStart = firstLineEnd === -1 || firstLineEnd > close ? afterOpen : firstLineEnd + 1;
    const code = markdown.slice(contentStart, close);
    // Keep the surrounding prose connected without interpreting the code as Markdown.
    // Preserve its final line boundary for heading/list markers after the closing fence.
    const lineEnd = /[\r\n\u2028\u2029]$/.test(code) ? code.slice(-1) : "";
    const literal = code.slice(0, code.length - lineEnd.length);
    if (literal) {
      text += `\0${codeBlocks.length}\0`;
      codeBlocks.push(literal);
    }
    text += lineEnd;
    pos = close + 3;
  }
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^[^\S\n]*[-*+]\s+/gm, "");
  text = text.replace(/^[^\S\n]*\d+\.\s+/gm, "");
  // Escaped input NUL pairs stay paired through prose formatting, so only our
  // single-NUL markers can restore code. Replacement output is not rescanned.
  text = text.replace(/\0(?:\0|(\d+)\0)/g, (_match, index: string | undefined) =>
    index === undefined ? "\0" : codeBlocks[Number(index)]!,
  );
  return normalizeWhitespace(text);
}

export function truncateWebFetchText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: truncateUtf16Safe(value, maxChars), truncated: true };
}

export async function extractBasicHtmlContent(params: {
  html: string;
  extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
  const cleanHtml = await sanitizeHtml(params.html);
  const rendered = htmlToMarkdown(cleanHtml);
  const text =
    stripInvisibleUnicode(
      params.extractMode === "text" ? markdownToText(rendered.text) : rendered.text,
    ) ||
    stripInvisibleUnicode(rendered.title ?? "") ||
    stripInvisibleUnicode(rendered.text);
  return text ? { text, title: rendered.title } : null;
}
