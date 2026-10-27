import { pruneMapToMaxSize } from "../../../src/infra/map-size.ts";
import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
import { i18n, t } from "../i18n/index.ts";
import { truncateText } from "../lib/format.ts";
import { markdownContentHtml, type MarkdownContent } from "../lib/markdown-content.ts";
import { parseGitHubLinkTarget } from "./github-link-target.ts";
import { createAssistantTranscriptPlainTextFallback } from "./markdown-assistant-transcript.ts";
import {
  markdownHighlightingPending,
  markdownHighlightingReady,
  renderMarkdownCodeBlock,
} from "./markdown-code-blocks.ts";
import { isHostLocalMarkdownFileHref } from "./markdown-file-links.ts";
import {
  prepareMarkdownHumanMentions,
  restoreMarkdownHumanMentions,
} from "./markdown-human-mentions.ts";
import type { MarkdownJson } from "./markdown-json.ts";
import { createMarkdownParser } from "./markdown-parser.ts";
import { stripProgressCardRawContentBlocks } from "./markdown-raw-content.ts";
import {
  MARKDOWN_PARSE_LIMIT,
  normalizeMarkdownRenderOptions,
  type MarkdownRenderEnv,
  type MarkdownRenderOptions,
} from "./markdown-render-options.ts";
import {
  markdownSanitizer,
  normalizeDocsRootHref,
  isControlUiRoutePath,
} from "./markdown-sanitizer.ts";
import { streamingMarkdownStableHtml } from "./markdown-streaming-state.ts";
import { isMarkdownBlockArtText, normalizeMarkdownLineBreaks } from "./markdown-text.ts";

export const MARKDOWN_CHAR_LIMIT = 140_000;
// Covers several message-heavy sessions during rapid switching. Only inputs
// up to 50k characters enter this 500-entry LRU, keeping memory bounded.
const MARKDOWN_CACHE_LIMIT = 500;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const markdownCache = new Map<string, { html: string; highlighting?: boolean }>();
export const HIGHLIGHTABLE_CODE_RE = /<pre><code(?! class="markdown-block-art")/u;

export function appendMarkdownTruncationNotice(truncated: {
  text: string;
  truncated: boolean;
  total: number;
}): string {
  const notice = truncated.truncated
    ? `\n\n${t("chat.markdown.truncated", {
        total: String(truncated.total),
        shown: String(truncated.text.length),
      })}`
    : "";
  return `${truncated.text}${notice}`;
}

function hasMarkdownContentName(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return Boolean(node.textContent?.trim());
  }
  if (
    !(node instanceof Element) ||
    node.getAttribute("aria-hidden")?.trim().toLowerCase() === "true"
  ) {
    return false;
  }
  if (node.matches("img[alt]")) {
    return Boolean(node.getAttribute("alt")?.trim());
  }
  if (node.matches("progress")) {
    // A progress value names its containing link; fallback text does not.
    const valueText = node.getAttribute("aria-valuetext");
    if (valueText !== null) {
      return Boolean(valueText.trim());
    }
    return (
      node.hasAttribute("value") ||
      node.hasAttribute("aria-valuenow") ||
      Boolean(node.getAttribute("aria-label")?.trim() || node.getAttribute("title")?.trim())
    );
  }
  return [...node.childNodes].some(hasMarkdownContentName);
}

function decorateMarkdownAnchor(node: Element): void {
  if (!(node instanceof HTMLAnchorElement)) {
    return;
  }
  const href = node.getAttribute("href");
  if (!href) {
    return;
  }

  if (isHostLocalMarkdownFileHref(href)) {
    node.removeAttribute("href");
    return;
  }

  const normalizedHref = normalizeDocsRootHref(href);
  if (normalizedHref !== href) {
    node.setAttribute("href", normalizedHref);
  }

  // Block dangerous URL schemes (javascript:, data:, vbscript:, etc.)
  try {
    const url = new URL(normalizedHref, document.baseURI);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
      node.removeAttribute("href");
      return;
    }
    if (parseGitHubLinkTarget(url.href)) {
      for (const element of [node, ...node.querySelectorAll("[title]")]) {
        const title = element.getAttribute("title");
        // A progress control needs a label; its value only names an enclosing link.
        const hasContentName = !element.matches("progress") && hasMarkdownContentName(element);
        if (title && !hasContentName && !element.getAttribute("aria-label")?.trim()) {
          element.setAttribute("aria-label", title);
        }
        // The rendered content owns the name; native hints must not survive preview closure.
        element.removeAttribute("title");
      }
    }
    if (url.origin === window.location.origin && isControlUiRoutePath(url.pathname)) {
      node.removeAttribute("rel");
      node.removeAttribute("target");
      return;
    }
  } catch {
    // Relative URLs are fine; malformed absolute URLs with dangerous schemes
    // will fail to parse and keep their href — but DOMPurify already strips
    // javascript: by default. This is defense-in-depth.
  }

  node.setAttribute("rel", "noreferrer noopener");
  node.setAttribute("target", "_blank");
}

const markdownParser = createMarkdownParser();

// Uncached render core shared by the static and streaming paths. The streaming
// tail changes on every delta, so routing it through here (instead of the cached
// wrapper) keeps per-message churn out of the LRU cache.
// The live entry supplies token rendering so settled history does not load it.
export function renderSanitizedMarkdown(
  renderInput: string,
  renderOptions: MarkdownRenderEnv,
  blockArt?: boolean,
  renderTokens?: typeof import("./markdown-tokens.ts").renderMarkdownTokens,
): MarkdownContent {
  const sanitizer = markdownSanitizer(decorateMarkdownAnchor, renderOptions.progressBars);
  const documentMode = renderOptions.mode === "document";
  const truncated = documentMode
    ? { text: renderInput, truncated: false, total: renderInput.length }
    : truncateText(renderInput, MARKDOWN_CHAR_LIMIT);
  const input = renderOptions.progressBars
    ? stripProgressCardRawContentBlocks(appendMarkdownTruncationNotice(truncated))
    : appendMarkdownTruncationNotice(truncated);
  if (blockArt ?? isMarkdownBlockArtText(truncated.text)) {
    return sanitizer.sanitize(
      renderMarkdownCodeBlock(input, "", renderOptions, { blockArt: true }),
    );
  }
  if (!documentMode && truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    // Large plain-text replies should stay readable without inheriting the
    // capped code-block chrome, while still preserving whitespace for logs
    // and other structured text that commonly trips the parse guard.
    return sanitizer.sanitize(toPlainTextElement(input, renderOptions));
  }
  let rendered: string | HTMLDivElement;
  try {
    if (renderTokens) {
      const tokens = markdownParser.parse(input, renderOptions);
      const fragment = renderTokens(tokens, renderOptions, sanitizer, decorateMarkdownAnchor);
      if (fragment) {
        const template = document.createElement("template");
        template.content.append(fragment);
        return { html: template.innerHTML, fragment: template.content };
      }
      rendered = markdownParser.renderer.render(tokens, markdownParser.options, renderOptions);
    } else {
      rendered = markdownParser.render(input, renderOptions);
    }
  } catch (err) {
    // Fall back to escaped plain text when md.render() throws (#36213).
    console.warn("[markdown] md.render failed, falling back to plain text:", err);
    rendered = toPlainTextElement(input, renderOptions);
  }
  return sanitizer.sanitize(rendered);
}

// Bare JSON bypasses Markdown normalization, which can alter literal Unicode separators.
// Both inputs still use the same code-block renderer and sanitizer boundary.
export function toSanitizedJsonHtml(json: MarkdownJson, options: MarkdownRenderOptions): string {
  return markdownSanitizer(decorateMarkdownAnchor)
    .sanitize(
      // HTML parsing normalizes literal CRs; character references survive both
      // sanitizer parsing and the final unsafeHTML commit without changing Raw.
      renderMarkdownCodeBlock(json.text, "json", normalizeMarkdownRenderOptions(options), {
        json,
      }).replaceAll("\r", "&#13;"),
    )
    .replaceAll("\r", "&#13;");
}

export function toSanitizedMarkdownHtml(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
): string {
  const renderOptions = normalizeMarkdownRenderOptions(options);
  const prepared =
    renderOptions.mode === "document" || markdownLocal.length <= MARKDOWN_PARSE_LIMIT
      ? prepareMarkdownHumanMentions(
          markdownLocal,
          renderOptions.humanMentions,
          markdownParser.utils.normalizeReference,
        )
      : { source: markdownLocal, tokens: [] };
  renderOptions.humanMentionTokens = prepared.tokens;
  const renderInput = normalizeMarkdownLineBreaks(
    stripUnsupportedCitationControlMarkers(prepared.source),
  );
  if (!renderInput.trim()) {
    return "";
  }
  if (renderInput.length > MARKDOWN_CACHE_MAX_CHARS) {
    return markdownContentHtml(renderSanitizedMarkdown(renderInput, renderOptions));
  }
  const cacheKey = `${markdownRenderKey(renderOptions)}\0${renderInput}`;
  let cached = markdownCache.get(cacheKey);
  // Only highlightable code changes when the optional highlighter loads.
  if (
    !cached ||
    (cached.highlighting !== undefined && cached.highlighting !== markdownHighlightingReady())
  ) {
    cached = { html: markdownContentHtml(renderSanitizedMarkdown(renderInput, renderOptions)) };
    if (HIGHLIGHTABLE_CODE_RE.test(cached.html)) {
      cached.highlighting = markdownHighlightingReady();
    }
  }
  markdownCache.delete(cacheKey);
  markdownCache.set(cacheKey, cached);
  pruneMapToMaxSize(markdownCache, MARKDOWN_CACHE_LIMIT);
  return cached.html;
}

export function markdownRenderKey(options: MarkdownRenderEnv): string {
  return `${i18n.getLocale()}\0${options.assistantTranscriptRoleHeaders}\0${options.codeBlockChrome}\0${options.codeBlockInteraction}\0${options.fileLinks}\0${options.interactiveImages}\0${options.linkFavicons}\0${options.progressBars}\0${options.mode}\0${options.remoteImages}\0${options.sessionLinks}\0${options.tableInteractions}\0${JSON.stringify(options.humanMentionTokens ?? [])}`;
}

function toPlainTextElement(value: string, options: MarkdownRenderEnv): HTMLDivElement {
  return createAssistantTranscriptPlainTextFallback(
    restoreMarkdownHumanMentions(normalizeMarkdownLineBreaks(value), options.humanMentionTokens),
    options.assistantTranscriptRoleHeaders,
  );
}

/** Keep late highlighting in the same mutable DOM owner, including stream finalization. */
export function partitionMarkdownHtml(html: string, streamKey?: string): [string, string] {
  if (!HIGHLIGHTABLE_CODE_RE.test(html) || !markdownHighlightingPending()) {
    return [html, ""];
  }
  const previous = streamingMarkdownStableHtml(streamKey);
  const stable = html.startsWith(previous) ? previous : "";
  return [stable, html.slice(stable.length)];
}
