/**
 * web_fetch extraction utilities.
 *
 * Converts lightweight HTML into bounded markdown/text without pulling in a full renderer.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { decodeHtmlEntityAt } from "../utils/html.js";
import { sanitizeHtml, stripInvisibleUnicode } from "./web-fetch-visibility.js";

/** Output mode requested by web_fetch extraction. */
export type ExtractMode = "markdown" | "text";

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript"]);
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

type RenderContext =
  | { kind: "root"; parts: string[] }
  | { kind: "title"; parts: string[] }
  | { kind: "anchor"; href: string | undefined; parts: string[] }
  | { kind: "heading"; level: number; parts: string[] }
  | { kind: "list-item"; parts: string[] };

type HtmlTagToken = {
  closing: boolean;
  name: string;
  raw: string;
  selfClosing: boolean;
};

type ReadTagResult = {
  token: HtmlTagToken | null;
  next: number;
  text?: string;
};

// Decode entities through the canonical shared decoder (agents/utils/html.ts) so web_fetch and the
// renderer share one entity contract — the divergent hand-rolled copy here was what truncated astral
// entities. A single left-to-right pass also avoids double-decoding "&amp;#39;" into "'", because the
// "&amp;" is consumed before its following "#39;" is ever seen as an entity.
function decodeEntities(value: string): string {
  if (!value.includes("&")) {
    return value;
  }
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "&") {
      // &nbsp; is not an escapable entity in the shared decoder; render it as a space.
      if (value.slice(i, i + 6).toLowerCase() === "&nbsp;") {
        out += " ";
        i += 5;
        continue;
      }
      const decoded = decodeHtmlEntityAt(value, i);
      if (decoded) {
        out += decoded.text;
        i += decoded.length - 1;
        continue;
      }
    }
    out += value[i];
  }
  return out;
}

function isAsciiWhitespace(value: string): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t" || value === "\f";
}

function isTagNameChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === "." ||
    value === "-" ||
    value === "_" ||
    value === ":"
  );
}

function isTagNameStartChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagBoundary(value: string | undefined): boolean {
  return !value || isAsciiWhitespace(value) || value === ">" || value === "/";
}

function asciiLower(value: string): string {
  const code = value.charCodeAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value;
}

function startsWithClosingTag(html: string, start: number, tagName: string): boolean {
  if (html[start] !== "<" || html[start + 1] !== "/") {
    return false;
  }
  for (let offset = 0; offset < tagName.length; offset += 1) {
    if (asciiLower(html[start + 2 + offset] ?? "") !== tagName[offset]) {
      return false;
    }
  }
  return isTagBoundary(html[start + 2 + tagName.length]);
}

function readRawTextOpenTagName(html: string, start: number): string | undefined {
  if (html[start] !== "<" || html[start + 1] === "/") {
    return undefined;
  }
  for (const tagName of RAW_TEXT_TAGS) {
    let matches = true;
    for (let offset = 0; offset < tagName.length; offset += 1) {
      if (asciiLower(html[start + 1 + offset] ?? "") !== tagName[offset]) {
        matches = false;
        break;
      }
    }
    if (matches && isTagBoundary(html[start + 1 + tagName.length])) {
      return tagName;
    }
  }
  return undefined;
}

function findRawTextOpenTagStart(html: string, start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    if (readRawTextOpenTagName(html, i)) {
      return i;
    }
  }
  return -1;
}

function startsLikeHtmlTag(html: string, start: number): boolean {
  const next = html[start + 1];
  return next === "!" || next === "?" || next === "/" || isTagNameStartChar(next ?? "");
}

function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  let afterEquals = false;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (readRawTextOpenTagName(html, i)) {
      return -1;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (afterEquals && isAsciiWhitespace(ch)) {
      continue;
    }
    if (afterEquals && (ch === '"' || ch === "'")) {
      quote = ch;
      afterEquals = false;
      continue;
    }
    afterEquals = false;
    if (ch === ">") {
      return i;
    }
    if (ch === "=") {
      afterEquals = true;
    }
  }
  return -1;
}

function isSelfClosingTagRaw(raw: string): boolean {
  const trimmed = raw.trimEnd();
  if (!trimmed.endsWith("/")) {
    return false;
  }
  const beforeSlash = trimmed[trimmed.length - 2];
  const tagBody = trimmed.slice(0, -1);
  let hasAttributeSeparator = false;
  for (const ch of tagBody) {
    if (isAsciiWhitespace(ch)) {
      hasAttributeSeparator = true;
      break;
    }
  }
  return !beforeSlash || isAsciiWhitespace(beforeSlash) || !hasAttributeSeparator;
}

function readTagToken(html: string, start: number): ReadTagResult | null {
  if (html.startsWith("<!--", start)) {
    const commentEnd = html.indexOf("-->", start + 4);
    return {
      token: null,
      next: commentEnd === -1 ? html.length : commentEnd + 3,
    };
  }

  const end = findTagEnd(html, start);
  if (end === -1) {
    return null;
  }

  let pos = start + 1;
  while (pos < end && isAsciiWhitespace(html[pos])) {
    pos += 1;
  }
  const closing = html[pos] === "/";
  if (closing) {
    pos += 1;
    while (pos < end && isAsciiWhitespace(html[pos])) {
      pos += 1;
    }
  }

  if (pos >= end || html[pos] === "!" || html[pos] === "?") {
    return {
      token: null,
      next: end + 1,
    };
  }

  const nameStart = pos;
  while (pos < end && isTagNameChar(html[pos])) {
    pos += 1;
  }
  if (pos === nameStart || !isTagNameStartChar(html[nameStart] ?? "")) {
    const rawTextStart = findRawTextOpenTagStart(html, start + 1, end + 1);
    if (rawTextStart !== -1) {
      return {
        token: null,
        next: rawTextStart,
        text: html.slice(start, rawTextStart),
      };
    }
    return {
      token: null,
      next: end + 1,
      text: html.slice(start, end + 1),
    };
  }

  const raw = html.slice(start + 1, end);
  return {
    token: {
      closing,
      name: html.slice(nameStart, pos).toLowerCase(),
      raw,
      selfClosing: isSelfClosingTagRaw(raw),
    },
    next: end + 1,
  };
}

function readAttributeValue(rawTag: string, name: string): string | undefined {
  const target = name.toLowerCase();
  let pos = 0;
  while (pos < rawTag.length && !isAsciiWhitespace(rawTag[pos])) {
    pos += 1;
  }
  while (pos < rawTag.length) {
    while (pos < rawTag.length && (isAsciiWhitespace(rawTag[pos]) || rawTag[pos] === "/")) {
      pos += 1;
    }
    const attrStart = pos;
    while (pos < rawTag.length && isTagNameChar(rawTag[pos])) {
      pos += 1;
    }
    if (pos === attrStart) {
      pos = skipUnsupportedAttribute(rawTag, pos);
      continue;
    }
    const attrName = rawTag.slice(attrStart, pos).toLowerCase();
    while (pos < rawTag.length && isAsciiWhitespace(rawTag[pos])) {
      pos += 1;
    }
    let value = "";
    if (rawTag[pos] === "=") {
      pos += 1;
      while (pos < rawTag.length && isAsciiWhitespace(rawTag[pos])) {
        pos += 1;
      }
      const quote = rawTag[pos];
      if (quote === '"' || quote === "'") {
        const valueStart = pos + 1;
        const valueEnd = rawTag.indexOf(quote, valueStart);
        if (valueEnd === -1) {
          value = rawTag.slice(valueStart);
          pos = rawTag.length;
        } else {
          value = rawTag.slice(valueStart, valueEnd);
          pos = valueEnd + 1;
        }
      } else {
        const valueStart = pos;
        while (
          pos < rawTag.length &&
          !isAsciiWhitespace(rawTag[pos]) &&
          rawTag[pos] !== '"' &&
          rawTag[pos] !== "'" &&
          rawTag[pos] !== "=" &&
          rawTag[pos] !== "<" &&
          rawTag[pos] !== ">" &&
          rawTag[pos] !== "`"
        ) {
          pos += 1;
        }
        value = rawTag.slice(valueStart, pos);
      }
    }
    if (attrName === target) {
      return decodeEntities(value);
    }
  }
  return undefined;
}

function skipUnsupportedAttribute(rawTag: string, start: number): number {
  let pos = start;
  while (pos < rawTag.length && !isAsciiWhitespace(rawTag[pos])) {
    const quote = rawTag[pos];
    if (quote === '"' || quote === "'") {
      const valueEnd = rawTag.indexOf(quote, pos + 1);
      pos = valueEnd === -1 ? rawTag.length : valueEnd + 1;
      continue;
    }
    pos += 1;
  }
  return pos;
}

function contextText(context: RenderContext): string {
  return context.parts.join("");
}

function appendText(stack: RenderContext[], value: string): void {
  stack[stack.length - 1]?.parts.push(value);
}

function closeContext(
  context: RenderContext,
  parent: RenderContext,
  state: { title?: string },
): void {
  const label = normalizeWhitespace(contextText(context));
  if (!label && context.kind !== "title" && !(context.kind === "anchor" && context.href)) {
    return;
  }
  switch (context.kind) {
    case "title":
      state.title ??= label || undefined;
      return;
    case "anchor":
      parent.parts.push(
        context.href && label ? `[${label}](${context.href})` : label || context.href || "",
      );
      return;
    case "heading":
      parent.parts.push(`\n${"#".repeat(context.level)} ${label}\n`);
      return;
    case "list-item":
      parent.parts.push(`\n- ${label}`);
      return;
    case "root":
      parent.parts.push(label);
  }
}

function closeMatchingContext(
  stack: RenderContext[],
  kind: RenderContext["kind"],
  state: { title?: string },
): boolean {
  const top = stack[stack.length - 1];
  if (!top || top.kind !== kind || stack.length < 2) {
    return false;
  }
  const context = stack.pop();
  const parent = stack[stack.length - 1];
  if (!context || !parent) {
    return false;
  }
  closeContext(context, parent, state);
  return true;
}

function closeRawTextTagEnd(html: string, tagName: string, contentStart: number): number {
  let closeStart = html.indexOf("</", contentStart);
  while (closeStart !== -1) {
    if (startsWithClosingTag(html, closeStart, tagName)) {
      const closeNameEnd = closeStart + tagName.length + 2;
      const closeEnd = html.indexOf(">", closeNameEnd);
      return closeEnd === -1 ? html.length : closeEnd + 1;
    }
    closeStart = html.indexOf("</", closeStart + 2);
  }
  return html.length;
}

function skipRawTextElement(html: string, start: number, tagName: string): number {
  const openerEnd = findTagEnd(html, start);
  const contentStart = openerEnd === -1 ? start + tagName.length + 1 : openerEnd + 1;
  return closeRawTextTagEnd(html, tagName, contentStart);
}

function htmlFragmentToMarkdown(html: string): { text: string; title?: string } {
  const root: RenderContext = { kind: "root", parts: [] };
  const stack: RenderContext[] = [root];
  const state: { title?: string } = {};

  for (let i = 0; i < html.length; ) {
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
        if (!startsLikeHtmlTag(html, i)) {
          appendText(stack, decodeEntities(html.slice(i, rawTextStart)));
        }
        i = rawTextStart;
        continue;
      }
      if (startsLikeHtmlTag(html, i)) {
        break;
      }
      appendText(stack, decodeEntities(html.slice(i)));
      break;
    }
    const { token, next, text } = read;
    i = next;
    if (!token) {
      if (text) {
        appendText(stack, decodeEntities(text));
      }
      continue;
    }

    if (token.closing) {
      if (token.name === "title") {
        closeMatchingContext(stack, "title", state);
      } else if (token.name === "a") {
        closeMatchingContext(stack, "anchor", state);
      } else if (/^h[1-6]$/.test(token.name)) {
        closeMatchingContext(stack, "heading", state);
      } else if (token.name === "li") {
        closeMatchingContext(stack, "list-item", state);
      } else if (BLOCK_BREAK_TAGS.has(token.name)) {
        appendText(stack, "\n");
      }
      continue;
    }

    if (RAW_TEXT_TAGS.has(token.name)) {
      i = closeRawTextTagEnd(html, token.name, i);
      continue;
    }
    if (token.name === "br" || token.name === "hr") {
      appendText(stack, "\n");
      continue;
    }
    if (token.name === "title" && !token.selfClosing) {
      stack.push({ kind: "title", parts: [] });
      continue;
    }
    if (token.name === "a" && !token.selfClosing) {
      stack.push({ kind: "anchor", href: readAttributeValue(token.raw, "href"), parts: [] });
      continue;
    }
    if (/^h[1-6]$/.test(token.name) && !token.selfClosing) {
      stack.push({ kind: "heading", level: Number.parseInt(token.name[1] ?? "1", 10), parts: [] });
      continue;
    }
    if (token.name === "li" && !token.selfClosing) {
      stack.push({ kind: "list-item", parts: [] });
    }
  }

  while (stack.length > 1) {
    const context = stack.pop();
    const parent = stack[stack.length - 1];
    if (context && parent) {
      closeContext(context, parent, state);
    }
  }

  return {
    text: normalizeWhitespace(contextText(root)),
    title: state.title,
  };
}

function stripTags(value: string): string {
  return htmlFragmentToMarkdown(value).text;
}

/** Collapses display whitespace while preserving paragraph breaks. */
export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Converts sanitized HTML into coarse markdown plus an optional title. */
export function htmlToMarkdown(html: string): { text: string; title?: string } {
  return htmlFragmentToMarkdown(html);
}

/** Removes markdown decoration for plain text extraction. */
export function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  let unfenced = "";
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("```", pos);
    if (open === -1) {
      unfenced += text.slice(pos);
      break;
    }
    unfenced += text.slice(pos, open);
    const afterOpen = open + 3;
    const close = text.indexOf("```", afterOpen);
    if (close === -1) {
      unfenced += text.slice(open);
      break;
    }
    const firstLineEnd = text.indexOf("\n", afterOpen);
    const contentStart = firstLineEnd === -1 || firstLineEnd > close ? afterOpen : firstLineEnd + 1;
    unfenced += text.slice(contentStart, close);
    pos = close + 3;
  }
  text = unfenced;
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

/** Truncates text by characters and reports whether truncation occurred. */
export function truncateText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: truncateUtf16Safe(value, maxChars), truncated: true };
}

/** Sanitizes HTML and extracts either markdown or plain text content. */
export async function extractBasicHtmlContent(params: {
  html: string;
  extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
  const cleanHtml = await sanitizeHtml(params.html);
  const rendered = htmlToMarkdown(cleanHtml);
  if (params.extractMode === "text") {
    const text =
      stripInvisibleUnicode(markdownToText(rendered.text)) ||
      stripInvisibleUnicode(rendered.title ?? "") ||
      stripInvisibleUnicode(normalizeWhitespace(stripTags(cleanHtml)));
    return text ? { text, title: rendered.title } : null;
  }
  const text = stripInvisibleUnicode(rendered.text) || stripInvisibleUnicode(rendered.title ?? "");
  return text ? { text, title: rendered.title } : null;
}
