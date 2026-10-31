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
// HTML can cover a long transcript; fragments remain limited independently.
// Count keys and HTML so a few large messages cannot fill the heap.
const MARKDOWN_CACHE_LIMIT = 2048;
const MARKDOWN_CACHE_TOTAL_CHARS = 8_000_000;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
type MarkdownCacheEntry = { html: string; highlighting?: boolean };
const markdownCache = new Map<string, MarkdownCacheEntry>();
let markdownCacheChars = 0;
// Only speculative preparation retains pristine trees until their next mount.
const preparedFragments = new Map<MarkdownCacheEntry, DocumentFragment>();
// Keep two nearby windows across a session switch or transcript search.
const PREPARED_FRAGMENT_LIMIT = 256;
export type MarkdownPrewarmMode = "html" | "idle-html" | "cold-fragment" | "fragment";
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
  returnFragment = false,
): MarkdownContent {
  const sanitizer = markdownSanitizer(
    decorateMarkdownAnchor,
    renderOptions.progressBars,
    returnFragment,
  );
  const sanitize = (input: string | Node): MarkdownContent => {
    if (!returnFragment) {
      return sanitizer.sanitize(input);
    }
    const template = document.createElement("template");
    template.content.append(sanitizer.sanitize(input, { RETURN_DOM_FRAGMENT: true }));
    return { html: template.innerHTML, fragment: template.content };
  };
  const documentMode = renderOptions.mode === "document";
  const truncated = documentMode
    ? { text: renderInput, truncated: false, total: renderInput.length }
    : truncateText(renderInput, MARKDOWN_CHAR_LIMIT);
  const input = renderOptions.progressBars
    ? stripProgressCardRawContentBlocks(appendMarkdownTruncationNotice(truncated))
    : appendMarkdownTruncationNotice(truncated);
  if (blockArt ?? isMarkdownBlockArtText(truncated.text)) {
    return sanitize(renderMarkdownCodeBlock(input, "", renderOptions, { blockArt: true }));
  }
  if (!documentMode && truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    // Large plain-text replies should stay readable without inheriting the
    // capped code-block chrome, while still preserving whitespace for logs
    // and other structured text that commonly trips the parse guard.
    return sanitize(toPlainTextElement(input, renderOptions));
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
  return sanitize(rendered);
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
  return markdownContentHtml(prepareSanitizedMarkdown(markdownLocal, options, false));
}

/** Chat can mount a fresh fragment or consume one prepared during idle time. */
export function toSanitizedMarkdownContent(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
): MarkdownContent {
  return prepareSanitizedMarkdown(markdownLocal, options, true);
}

/** Warm HTML once, optionally retaining or restoring a fragment for the next mount. */
export function prewarmSanitizedMarkdown(
  markdownLocal: string,
  options: MarkdownRenderOptions,
  mode: MarkdownPrewarmMode = "cold-fragment",
): boolean {
  return prepareSanitizedMarkdown(markdownLocal, options, false, true, mode);
}

function prepareSanitizedMarkdown(
  markdownLocal: string,
  options: MarkdownRenderOptions,
  returnFragment: boolean,
): MarkdownContent;
function prepareSanitizedMarkdown(
  markdownLocal: string,
  options: MarkdownRenderOptions,
  returnFragment: boolean,
  prewarm: true,
  mode?: MarkdownPrewarmMode,
): boolean;
function prepareSanitizedMarkdown(
  markdownLocal: string,
  options: MarkdownRenderOptions,
  returnFragment: boolean,
  prewarm = false,
  mode: MarkdownPrewarmMode = "cold-fragment",
): MarkdownContent | boolean {
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
    return prewarm ? false : "";
  }
  if (renderInput.length > MARKDOWN_CACHE_MAX_CHARS) {
    if (prewarm) {
      return false;
    }
    return renderSanitizedMarkdown(
      renderInput,
      renderOptions,
      undefined,
      undefined,
      returnFragment,
    );
  }
  const cacheKey = `${markdownRenderKey(renderOptions)}\0${renderInput}`;
  let cached = markdownCache.get(cacheKey);
  const previousChars = cached ? cacheKey.length + cached.html.length : 0;
  const idle = prewarm && mode === "idle-html";
  let content: MarkdownContent | undefined;
  // Only highlightable code changes when the optional highlighter loads.
  if (
    !cached ||
    (cached.highlighting !== undefined && cached.highlighting !== markdownHighlightingReady())
  ) {
    // Distant idle work must never evict the reader's nearby preparation.
    if (
      idle &&
      ((!cached && markdownCache.size >= MARKDOWN_CACHE_LIMIT) ||
        markdownCacheChars - previousChars + cacheKey.length >= MARKDOWN_CACHE_TOTAL_CHARS)
    ) {
      return false;
    }
    if (cached) {
      preparedFragments.delete(cached);
    }
    content = renderSanitizedMarkdown(
      renderInput,
      renderOptions,
      undefined,
      undefined,
      prewarm && mode !== "html" && mode !== "idle-html",
    );
    cached = { html: markdownContentHtml(content) };
    if (
      idle &&
      markdownCacheChars - previousChars + cacheKey.length + cached.html.length >
        MARKDOWN_CACHE_TOTAL_CHARS
    ) {
      // Rendering still spent this slice even when its result cannot be retained.
      return true;
    }
    if (HIGHLIGHTABLE_CODE_RE.test(cached.html)) {
      cached.highlighting = markdownHighlightingReady();
    }
    if (prewarm && mode !== "html" && mode !== "idle-html" && typeof content !== "string") {
      preparedFragments.set(cached, content.fragment);
      pruneMapToMaxSize(preparedFragments, PREPARED_FRAGMENT_LIMIT);
    }
  } else if (prewarm) {
    if (mode !== "fragment" || preparedFragments.has(cached)) {
      return false;
    }
    // The cache owns sanitized HTML. Rebuild its evicted DOM ahead of a return
    // scroll, without reparsing Markdown or rerunning the sanitizer.
    const template = document.createElement("template");
    template.innerHTML = cached.html;
    preparedFragments.set(cached, template.content);
    pruneMapToMaxSize(preparedFragments, PREPARED_FRAGMENT_LIMIT);
  } else if (returnFragment) {
    const fragment = preparedFragments.get(cached);
    if (fragment) {
      content = { html: cached.html, fragment };
      preparedFragments.delete(cached);
    }
  }
  const previous = markdownCache.get(cacheKey);
  if (previous) {
    markdownCacheChars -= cacheKey.length + previous.html.length;
    markdownCache.delete(cacheKey);
  }
  markdownCache.set(cacheKey, cached);
  markdownCacheChars += cacheKey.length + cached.html.length;
  while (
    markdownCache.size > MARKDOWN_CACHE_LIMIT ||
    markdownCacheChars > MARKDOWN_CACHE_TOTAL_CHARS
  ) {
    const [key, entry] = markdownCache.entries().next().value!;
    markdownCacheChars -= key.length + entry.html.length;
    markdownCache.delete(key);
    preparedFragments.delete(entry);
  }
  return prewarm ? true : (content ?? cached.html);
}

export function markdownRenderKey(options: MarkdownRenderEnv): string {
  return `${i18n.getLocale()}\0${options.assistantTranscriptRoleHeaders}\0${options.codeBlockChrome}\0${options.codeBlockInteraction}\0${options.fileLinks}\0${options.documentFileLinks}\0${options.interactiveImages}\0${options.linkFavicons}\0${options.progressBars}\0${options.mode}\0${options.remoteImages}\0${options.sessionLinks}\0${options.tableInteractions}\0${JSON.stringify(options.humanMentionTokens ?? [])}`;
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
