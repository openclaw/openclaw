import { createSignal } from "solid-js";
import { escapeHtml } from "../../../src/shared/html-escape.js";

type Highlighter = typeof import("./markdown-highlight-runtime.ts").highlightCodeHtml;
const [readHighlighter, setHighlighter] = createSignal<Highlighter | null | undefined>(undefined);
let highlighterLoad: Promise<void> | undefined;

/** Shared by code renderers; a failed optional chunk leaves escaped, copyable text. */
export function loadMarkdownHighlighter(): Promise<void> {
  return (highlighterLoad ??= importMarkdownHighlighter());
}

async function importMarkdownHighlighter(): Promise<void> {
  try {
    const { highlightCodeHtml } = await import("./markdown-highlight-runtime.ts");
    setHighlighter(() => highlightCodeHtml);
  } catch {
    setHighlighter(null);
    console.warn("[markdown] Syntax highlighting could not be loaded; showing plain code.");
  }
}

// Cached Markdown must subscribe even when a previous render already filled its cache.
export function markdownHighlightingReady(): boolean {
  return typeof readHighlighter() === "function";
}

export function markdownHighlightingPending(): boolean {
  return highlighterLoad !== undefined && readHighlighter() === undefined;
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
