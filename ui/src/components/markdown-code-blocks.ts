import { createSignal } from "solid-js";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { t } from "../i18n/index.ts";
import { registerCodeBlocksEnglish } from "../i18n/locales/en-code-blocks.ts";
import { CODE_PREVIEW_LINE_COUNT } from "./markdown-code-highlight-chunks.ts";
import { copyMarkdownText } from "./markdown-copy.ts";
import {
  parseMarkdownJson,
  renderMarkdownJsonModes,
  renderMarkdownJsonTree,
  type MarkdownJson,
} from "./markdown-json.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";
import { isMarkdownBlockArtText } from "./markdown-text.ts";

registerCodeBlocksEnglish();

const blockArtCopyPayloadPrefix = "openclaw:block-art-code:";
const blockArtCodeBlockCopyPayloadEncoding = "block-art-json";
const CODE_STICKY_ACTIONS_LINE_THRESHOLD = 300;

type Highlighter = typeof import("./markdown-highlight-runtime.ts").highlightCodeHtml;
const [readHighlighter, setHighlighter] = createSignal<Highlighter | null | undefined>(undefined);
let highlighterLoad: Promise<void> | undefined;

/** Shared by code renderers; a failed optional chunk leaves escaped, copyable text. */
function loadMarkdownHighlighter(): Promise<void> {
  highlighterLoad ??= import("./markdown-highlight-runtime.ts").then(
    (runtime) => {
      setHighlighter(() => runtime.highlightCodeHtml);
    },
    () => {
      setHighlighter(null);
      console.warn("[markdown] Syntax highlighting could not be loaded; showing plain code.");
    },
  );
  return highlighterLoad;
}

// Cached Markdown must subscribe even when a previous render already filled its cache.
export function markdownHighlightingReady(): boolean {
  return typeof readHighlighter() === "function";
}

export function markdownHighlightingPending(): boolean {
  return highlighterLoad !== undefined && readHighlighter() === undefined;
}

function encodeCodeBlockCopyPayload(value: string): string {
  // DOMPurify removes attributes containing XML comment ends or closing tags.
  // JSON escapes survive sanitization and decode only as clipboard text.
  const payload = JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `${blockArtCopyPayloadPrefix}${payload}`;
}

function decodeCodeBlockCopyPayload(value: string, encoding?: string): string {
  if (
    encoding !== blockArtCodeBlockCopyPayloadEncoding ||
    !value.startsWith(blockArtCopyPayloadPrefix)
  ) {
    return value;
  }
  try {
    const decoded = JSON.parse(value.slice(blockArtCopyPayloadPrefix.length));
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

export function readMarkdownCodeBlockCopyText(button: HTMLElement): string {
  return decodeCodeBlockCopyPayload(button.dataset.code ?? "", button.dataset.codeEncoding);
}

/**
 * Single click owner for every fenced-code control. Copy, reveal, and wrap ship
 * in the same markup, so one entry point keeps a host from wiring part of it and
 * leaving the rest of the block inert.
 */
export function handleMarkdownCodeBlockClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  handleCodeBlockDisclosure(target);
  const button = target.closest<HTMLElement>(".code-block-copy");
  if (!button) {
    return;
  }
  const code = readMarkdownCodeBlockCopyText(button);
  copyMarkdownText(
    button,
    code,
    () => readMarkdownCodeBlockCopyText(button) === code,
    (copied) => {
      if (copied === undefined) {
        button.classList.remove("copied", "copy-failed");
        button.setAttribute("aria-label", t("common.copyCode"));
      } else {
        button.classList.toggle("copied", copied);
        button.classList.toggle("copy-failed", !copied);
        button.setAttribute("aria-label", t(copied ? "common.copied" : "common.copyFailed"));
      }
    },
  );
}

function handleCodeBlockDisclosure(target: Element): void {
  const wrapper = target.closest<HTMLElement>(".code-block-wrapper");
  if (!wrapper) {
    return;
  }
  const expandButton = target.closest<HTMLButtonElement>(".code-block-expand");
  if (expandButton) {
    const transferFocus = expandButton.matches(":focus-visible");
    wrapper.classList.add("is-expanded");
    expandButton.setAttribute("aria-expanded", "true");
    // Revealing hides this one-way control. Keep keyboard readers on the code
    // without moving pointer focus or scrolling the transcript to the block's start.
    if (transferFocus) {
      const viewport = expandButton.ownerDocument.getElementById(
        expandButton.getAttribute("aria-controls") ?? "",
      );
      if (viewport) {
        viewport.tabIndex = -1;
        viewport.focus({ preventScroll: true });
      }
    }
  }
  const jsonMode = target.closest<HTMLButtonElement>(".code-block-json-mode");
  if (jsonMode) {
    wrapper.classList.toggle("is-json-raw", jsonMode.dataset.jsonMode === "raw");
    for (const button of wrapper.querySelectorAll(".code-block-json-mode")) {
      button.setAttribute("aria-pressed", String(button === jsonMode));
    }
    updateCodeBlockWidthOverflow(wrapper);
  }
  const wrapButton = target.closest<HTMLButtonElement>(".code-block-wrap");
  if (!wrapButton) {
    return;
  }
  const wrapped = wrapper.classList.toggle("is-wrapped");
  const label = t(wrapped ? "chat.codeBlock.disableWrap" : "chat.codeBlock.enableWrap");
  wrapButton.setAttribute("aria-pressed", String(wrapped));
  wrapButton.setAttribute("aria-label", label);
  wrapButton.title = label;
  updateCodeBlockWidthOverflow(wrapper);
}

function updateCodeBlockWidthOverflow(wrapper: HTMLElement): void {
  measureCodeBlockWidthOverflow(wrapper)?.();
}

/** Read geometry before applying overflow chrome. */
export function measureCodeBlockWidthOverflow(wrapper: HTMLElement): (() => void) | undefined {
  const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport");
  const code = viewport?.querySelector<HTMLElement>("code");
  if (!viewport || !code) {
    return undefined;
  }
  const overflowing =
    !wrapper.classList.contains("is-wrapped") && code.scrollWidth > viewport.clientWidth + 1;
  return () => {
    wrapper.classList.toggle("has-horizontal-overflow", overflowing);
  };
}

/** Highlight when available; plain escaped code remains readable while the chunk loads. */
export function highlightCodeHtml(text: string, lang: string): string {
  const highlighter = readHighlighter();
  if (highlighter) {
    return highlighter(text, lang);
  }
  if (text.trim()) {
    void loadMarkdownHighlighter();
  }
  return escapeHtml(text);
}

/** Highlight a JSON/JSON5 snippet; output is escaped hljs markup safe for unsafeHTML in a code block. */
export function highlightJsonHtml(text: string): string {
  return highlightCodeHtml(text, "json");
}

export function markdownCodeClass(lang: string, highlighted: string): string {
  const classes = [
    highlighted.includes("hljs-") ? "hljs" : "",
    lang ? `language-${lang}` : "",
  ].filter(Boolean);
  return classes.join(" ");
}

function renderCodeBlockHeader(lang: string, actions: string): string {
  const language = escapeHtml(lang || t("chat.codeBlock.languageFallback"));
  return `<div class="code-block-header" data-markdown-key="header"><span class="code-block-lang">${language}</span><div class="code-block-actions">${actions}</div></div>`;
}

function renderCodeBlockCopyButton(text: string): string {
  // Attribute sanitization trims plain values; encode copied whitespace with the text.
  const attrSafe = escapeHtml(markdownCodeBlockCopyAttributes(text)["data-code"]);
  return `<button type="button" class="code-block-copy" data-markdown-key="copy" data-code="${attrSafe}" data-code-encoding="${blockArtCodeBlockCopyPayloadEncoding}" aria-label="${escapeHtml(t("common.copyCode"))}"><span class="code-block-copy__idle" aria-hidden="true"></span><span class="code-block-copy__done" aria-hidden="true"></span><span class="code-block-copy__failed" aria-hidden="true">!</span></button>`;
}

export function renderMarkdownCodeBlock(
  text: string,
  lang: string,
  env: unknown,
  options: { blockArt?: boolean; copyText?: string; highlight?: boolean; json?: MarkdownJson } = {},
): string {
  const blockArt = options.blockArt || isMarkdownBlockArtText(text);
  const highlight = options.highlight;
  // SAFETY: markdown-it supplies normalized internal renderer options.
  const renderEnv = env as Partial<MarkdownRenderEnv> | undefined;
  const interactive = renderEnv?.codeBlockInteraction === "interactive";
  const { wrapperClass, hiddenLineCount, long } = markdownCodeBlockLayout(text, lang);
  const deferredHighlight =
    interactive && long && hiddenLineCount > 0 && highlight !== false && !blockArt;
  const highlighted =
    blockArt || highlight === false || deferredHighlight
      ? escapeHtml(text)
      : highlightCodeHtml(text, lang);
  const codeClass = blockArt ? "markdown-block-art" : markdownCodeClass(lang, highlighted);
  const classAttr = codeClass ? ` class="${escapeHtml(codeClass)}"` : "";
  const deferredAttr = deferredHighlight ? ` data-code-highlight="${escapeHtml(lang)}"` : "";
  const codeBlock = `<pre><code${classAttr}${deferredAttr}>${highlighted}</code></pre>`;
  const copyEnabled = renderEnv?.codeBlockChrome !== "none";
  if (!copyEnabled && !interactive) {
    return codeBlock;
  }
  const copyButton = copyEnabled ? renderCodeBlockCopyButton(options.copyText ?? text) : "";
  // Reveal and wrap controls are inert without a host that runs the code-block
  // lifecycle, so only interaction-owning hosts get the collapsible markup.
  if (!interactive) {
    return `<div class="${wrapperClass}">${renderCodeBlockHeader(lang, copyButton)}${codeBlock}</div>`;
  }
  const jsonSource =
    !blockArt && highlight !== false && (!lang || lang.toLowerCase() === "json")
      ? (options.json ?? parseMarkdownJson(text))
      : null;
  const tree = jsonSource ? renderMarkdownJsonTree(jsonSource) : "";
  const hiddenCount = { count: String(hiddenLineCount) };
  const expandLabel = t(
    hiddenLineCount === 1 ? "chat.codeBlock.showHiddenLine" : "chat.codeBlock.showHiddenLines",
    hiddenCount,
  );
  const hiddenLabel = t(
    hiddenLineCount === 1 ? "chat.codeBlock.hiddenLine" : "chat.codeBlock.hiddenLines",
    hiddenCount,
  );
  const expandButton = hiddenLineCount
    ? `<button type="button" class="code-block-expand" data-markdown-key="expand" aria-label="${escapeHtml(expandLabel)}" aria-expanded="false"><span class="code-block-chevron" aria-hidden="true"></span><span>${escapeHtml(hiddenLabel)}</span></button>`
    : "";
  const wrapLabel = escapeHtml(t("chat.codeBlock.enableWrap"));
  const wrapButton = `<button type="button" class="code-block-wrap" data-markdown-key="wrap" aria-label="${wrapLabel}" title="${wrapLabel}" aria-pressed="false"><span class="code-block-wrap__icon" aria-hidden="true"></span></button>`;
  const header = renderCodeBlockHeader(
    lang,
    `${tree ? renderMarkdownJsonModes() : ""}${wrapButton}${copyButton}`,
  );
  return `<div class="${wrapperClass}${tree ? " code-block-wrapper--json" : ""}${hiddenLineCount ? " is-collapsible" : ""}">${header}${tree}<div class="code-block-viewport" data-markdown-key="viewport">${codeBlock}</div>${expandButton}</div>`;
}

export function markdownCodeBlockLayout(text: string, lang: string) {
  const lineCount = countCodeBlockLines(text);
  return {
    long: lineCount > CODE_STICKY_ACTIONS_LINE_THRESHOLD,
    wrapperClass: `code-block-wrapper${lineCount > CODE_STICKY_ACTIONS_LINE_THRESHOLD ? " code-block-wrapper--long" : ""}`,
    hiddenLineCount: ["text", "md", "markdown"].includes(lang.trim().toLowerCase())
      ? 0
      : Math.max(0, lineCount - CODE_PREVIEW_LINE_COUNT),
  };
}

export function markdownCodeBlockCopyAttributes(text: string) {
  return {
    "data-code": encodeCodeBlockCopyPayload(text),
    "data-code-encoding": blockArtCodeBlockCopyPayloadEncoding,
  };
}

function countCodeBlockLines(text: string): number {
  let lines = 1;
  let index = -1;
  // Match copied code: one terminal newline does not add a displayed line.
  while ((index = text.indexOf("\n", index + 1)) >= 0 && index < text.length - 1) {
    lines += 1;
  }
  return lines;
}

export function markdownCodeBlockCopyText(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}
