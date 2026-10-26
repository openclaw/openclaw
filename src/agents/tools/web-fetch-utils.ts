import { stripInlineLinks } from "@openclaw/normalization-core/markdown-plain-text";
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
  "pre",
  "table",
  "tr",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "address",
  "aside",
  "blockquote",
  "caption",
  "center",
  "details",
  "dialog",
  "dir",
  "fieldset",
  "figcaption",
  "figure",
  "form",
  "hgroup",
  "legend",
  "main",
  "menu",
  "nav",
  "search",
  "summary",
]);
// Keep malformed nested markup from making end-of-document context unwind quadratic.
// web_fetch favors bounded, auditable text over preserving deep broken HTML structure.
const MAX_RENDER_CONTEXT_DEPTH = 32;
const MAX_BLOCK_BREAK_LOOKBACK = 64;

type RenderContext =
  | { kind: "root"; parts: string[] }
  | { kind: "title"; parts: string[] }
  | { kind: "anchor"; href: string | undefined; hasText: boolean; parts: string[] }
  | { kind: "heading"; level: number; parts: string[] }
  | { kind: "list-item"; parts: string[] }
  | { kind: "pre"; parts: string[] };

type RenderState = {
  linksAsText?: boolean;
  title?: string;
  preBlocks: string[];
};

function decodeEntities(value: string): string {
  // Display extraction historically accepted mixed-case &nbsp; and treats non-breaking spaces as
  // ordinary collapsible whitespace. Normalize it before the shared decoder to stay single-pass.
  return decodeHtmlEntities(value.replace(/&nbsp;/gi, "\u00a0")).replaceAll("\u00a0", " ");
}

function readAnchorHref(rawTag: string): string | undefined {
  const value = readHtmlAttribute(rawTag, "href", "render");
  return value === undefined ? undefined : decodeEntities(value);
}

function escapePreMarkerText(value: string): string {
  // Internal pre markers use single NULs. Double NULs in fetched text so even
  // entity-decoded marker-like prose cannot be mistaken for a placeholder.
  return value.replaceAll("\u0000", "\u0000\u0000");
}

function appendText(stack: RenderContext[], value: string): void {
  const context = stack[stack.length - 1];
  context?.parts.push(context.kind === "pre" ? value : escapePreMarkerText(value));
  if (context?.kind === "anchor" && /\S/.test(value)) {
    context.hasText = true;
  }
}

// A block that starts mid-line must not run into the text before it. The look-back over trailing
// spaces is bounded so long whitespace runs cannot make every block start rescan them.
function breakLineBeforeBlock(stack: RenderContext[]): void {
  const parts = stack[stack.length - 1]?.parts ?? [];
  let budget = MAX_BLOCK_BREAK_LOOKBACK;
  for (let i = parts.length - 1; i >= 0 && budget > 0; i -= 1, budget -= 1) {
    const part = parts[i]!;
    for (let j = part.length - 1; j >= 0 && budget > 0; j -= 1, budget -= 1) {
      if (part[j] !== " " && part[j] !== "\t") {
        if (part[j] !== "\n") {
          appendText(stack, "\n");
        }
        return;
      }
    }
  }
}

function formatPreformattedMarkdown(value: string): string {
  const code = value.replace(/\r\n?/g, "\n");
  let longestBacktickRun = 0;
  let currentBacktickRun = 0;
  for (const character of code) {
    if (character === "`") {
      currentBacktickRun += 1;
      longestBacktickRun = Math.max(longestBacktickRun, currentBacktickRun);
    } else {
      currentBacktickRun = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}`;
}

function restorePreformattedMarkdown(value: string, state: RenderState): string {
  return value.replace(/\0(?:\0|openclaw-pre-(\d+)\0)/g, (_match, index: string | undefined) =>
    index === undefined ? "\0" : formatPreformattedMarkdown(state.preBlocks[Number(index)]!),
  );
}

function closeContext(context: RenderContext, parent: RenderContext, state: RenderState): void {
  if (context.kind === "pre") {
    const code = context.parts.join("");
    if (code.trim()) {
      const index = state.preBlocks.push(code) - 1;
      parent.parts.push(`\n\n\0openclaw-pre-${index}\0\n\n`);
    } else {
      parent.parts.push("\n");
    }
    return;
  }
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
        !state.linksAsText && context.href && label
          ? `[${label}](${escapePreMarkerText(context.href)})`
          : label || escapePreMarkerText(context.href || ""),
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

function closeTopContext(stack: RenderContext[], state: RenderState): void {
  const context = stack.pop()!;
  closeContext(context, stack[stack.length - 1]!, state);
}

function closeThroughContext(
  stack: RenderContext[],
  kind: RenderContext["kind"],
  state: RenderState,
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
  state: RenderState,
): void {
  while (stack.length >= MAX_RENDER_CONTEXT_DEPTH) {
    closeTopContext(stack, state);
  }
  stack.push(context);
}

export function htmlToMarkdown(
  html: string,
  options?: { linksAsText?: boolean },
): { text: string; title?: string } {
  const root: RenderContext = { kind: "root", parts: [] };
  const stack: RenderContext[] = [root];
  const state: RenderState = { preBlocks: [], linksAsText: options?.linksAsText };
  const tableRowCellCounts: number[] = [];

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

    // Within pre, tags are presentation only; their text must stay literal.
    if (stack[stack.length - 1]?.kind === "pre" && token.name !== "pre") {
      if (token.name === "br" && !token.closing) {
        appendText(stack, "\n");
      }
      continue;
    }
    const kind =
      token.name === "title"
        ? "title"
        : token.name === "pre"
          ? "pre"
          : token.name === "a"
            ? "anchor"
            : /^h[1-6]$/.test(token.name)
              ? "heading"
              : token.name === "li"
                ? "list-item"
                : undefined;
    if (token.closing) {
      if (token.name === "tr") {
        tableRowCellCounts.pop();
      }
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
    if (token.name === "tr" && !token.selfClosing) {
      tableRowCellCounts.push(0);
    }
    if ((token.name === "td" || token.name === "th") && !token.selfClosing) {
      const rowIndex = tableRowCellCounts.length - 1;
      if (rowIndex >= 0) {
        const cellCount = tableRowCellCounts[rowIndex] ?? 0;
        if (cellCount > 0) {
          appendText(stack, " | ");
        }
        tableRowCellCounts[rowIndex] = cellCount + 1;
      }
    }
    if (BLOCK_BREAK_TAGS.has(token.name)) {
      if (closeThroughContext(stack, "anchor", state, true)) {
        appendText(stack, " ");
      } else {
        breakLineBeforeBlock(stack);
      }
    }
    if (token.name === "pre") {
      appendText(stack, "\n");
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
    text: restorePreformattedMarkdown(normalizeWhitespace(root.parts.join("")), state),
    title: state.title ? restorePreformattedMarkdown(state.title, state) : state.title,
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

function readBacktickRunEnd(value: string, start: number): number {
  let end = start + 1;
  while (value[end] === "`") {
    end += 1;
  }
  return end;
}

export function markdownToText(markdown: string): string {
  const codeBlocks: string[] = [];
  let text = "";
  const opener = /`{3,}|(?:^|\n) {0,3}(~{3,})/g;
  let pos = 0;
  while (pos < markdown.length) {
    opener.lastIndex = pos;
    const opening = opener.exec(markdown);
    if (!opening) {
      text += markdown.slice(pos).replaceAll("\0", "\0\0");
      break;
    }
    const isTilde = opening[1] !== undefined;
    const open = opening.index + (isTilde && opening[0].startsWith("\n") ? 1 : 0);
    text += markdown.slice(pos, open).replaceAll("\0", "\0\0");
    const afterOpen = opening.index + opening[0].length;
    const fenceLength = opening[1]?.length ?? afterOpen - open;
    let close: { start: number; end: number } | undefined;
    if (isTilde) {
      // Tilde blocks require a line-owning close; retain the existing inline backtick behavior.
      const closing = /(?:^|\n) {0,3}(~{3,})[ \t]*\r?(?=\n|$)/g;
      closing.lastIndex = afterOpen;
      for (let match = closing.exec(markdown); match; match = closing.exec(markdown)) {
        if (match[1]!.length >= fenceLength) {
          close = {
            start: match.index + (match[0].startsWith("\n") ? 1 : 0),
            end: match.index + match[0].length,
          };
          break;
        }
      }
    } else {
      let closingStart = afterOpen;
      while (closingStart < markdown.length) {
        const start = markdown.indexOf("`", closingStart);
        if (start === -1) {
          break;
        }
        const end = readBacktickRunEnd(markdown, start);
        if (end - start >= fenceLength) {
          // Consume only the matching run, preserving adjacent blocks.
          close = { start, end: start + fenceLength };
          break;
        }
        closingStart = end;
      }
    }
    const firstLineEnd = markdown.indexOf("\n", afterOpen);
    if (!close && !isTilde) {
      const lineStart = markdown.lastIndexOf("\n", open) + 1;
      if (firstLineEnd === -1 || !/^[ \t]*$/.test(markdown.slice(lineStart, open))) {
        text += markdown.slice(open).replaceAll("\0", "\0\0");
        break;
      }
    }
    const contentEnd = close?.start ?? markdown.length;
    const contentStart =
      isTilde && firstLineEnd === -1
        ? markdown.length
        : firstLineEnd === -1 || firstLineEnd > contentEnd
          ? afterOpen
          : firstLineEnd + 1;
    const code = markdown.slice(contentStart, contentEnd);
    // Keep the surrounding prose connected without interpreting the code as Markdown.
    // Preserve its final line boundary for heading/list markers after the closing fence.
    const lineEnd = /[\r\n\u2028\u2029]$/.test(code) ? code.slice(-1) : "";
    const literal = code.slice(0, code.length - lineEnd.length);
    if (literal) {
      text += `\0${codeBlocks.length}\0`;
      codeBlocks.push(literal);
    }
    text += lineEnd;
    pos = close?.end ?? markdown.length;
  }
  text = stripInlineLinks(text, { images: "omit" });
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^[^\S\n]*[-*+]\s+/gm, "");
  text = text.replace(/^[^\S\n]*\d+\.\s+/gm, "");
  // Escaped input NUL pairs stay paired through prose formatting, so only our
  // single-NUL markers can restore code. Replacement output is not rescanned.
  return normalizeWhitespace(text).replace(
    /\0(?:\0|(\d+)\0)/g,
    (_match, index: string | undefined) =>
      index === undefined ? "\0" : codeBlocks[Number(index)]!,
  );
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
  // HTML labels are literal text, not authored Markdown. Do not serialize destinations
  // only to parse them back out in text mode. Keep Markdown rendering unchanged.
  const rendered = htmlToMarkdown(cleanHtml, { linksAsText: params.extractMode === "text" });
  const text =
    stripInvisibleUnicode(
      params.extractMode === "text" ? markdownToText(rendered.text) : rendered.text,
    ) ||
    stripInvisibleUnicode(rendered.title ?? "") ||
    stripInvisibleUnicode(rendered.text);
  return text ? { text, title: rendered.title } : null;
}
