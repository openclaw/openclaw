/**
 * Highlight.js emits HTML spans; this module walks that small HTML subset and
 * maps active scopes to caller-provided text formatters.
 */
import { createRequire } from "node:module";
import { decodeHtmlEntities } from "../../shared/html-entities.js";

type HighlightJs = {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals: boolean },
  ): { value: string };
};

let highlightJsRuntime: HighlightJs | undefined;

function isHighlightJs(value: unknown): value is HighlightJs {
  return (
    typeof value === "object" &&
    value !== null &&
    "getLanguage" in value &&
    typeof value.getLanguage === "function" &&
    "highlight" in value &&
    typeof value.highlight === "function"
  );
}

function loadHighlightJsRuntime(): HighlightJs {
  if (highlightJsRuntime) {
    return highlightJsRuntime;
  }
  // highlight.js ships `/// <reference lib="dom" />` in its d.ts, which would
  // silently re-inject DOM globals into the DOM-free core program. Load it
  // untyped and validate the narrow API we use instead of importing its types.
  const runtime: unknown = createRequire(import.meta.url)("highlight.js");
  if (!isHighlightJs(runtime)) {
    throw new TypeError("highlight.js did not expose the expected Node API");
  }
  return (highlightJsRuntime = runtime);
}

type HighlightFormatter = (text: string) => string;
/** Mapping from highlight.js scope names to text formatters. */
type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
  const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const classValue = match?.[1] ?? match?.[2];
  if (!classValue) {
    return undefined;
  }

  for (const className of classValue.split(/\s+/)) {
    if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
      return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
    }
  }

  return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
  const exact = theme[scope];
  if (exact) {
    return exact;
  }

  for (const separator of [".", "-"]) {
    const index = scope.indexOf(separator);
    if (index !== -1) {
      const prefixFormatter = theme[scope.slice(0, index)];
      if (prefixFormatter) {
        return prefixFormatter;
      }
    }
  }

  return undefined;
}

function getActiveFormatter(
  scopes: Array<string | undefined>,
  theme: HighlightTheme,
): HighlightFormatter | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope) {
      continue;
    }
    const formatter = getScopeFormatter(scope, theme);
    if (formatter) {
      return formatter;
    }
  }
  return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
  if (!html.startsWith("<span", index)) {
    return false;
  }
  const nextChar = html[index + "<span".length];
  return (
    nextChar === ">" ||
    nextChar === " " ||
    nextChar === "\t" ||
    nextChar === "\n" ||
    nextChar === "\r"
  );
}

/** Renders highlight.js span HTML into themed plain text. */
function renderHighlightedHtml(html: string, theme: HighlightTheme): string {
  let output = "";
  let textBuffer = "";
  const scopes: Array<string | undefined> = [];

  const flushText = () => {
    if (!textBuffer) {
      return;
    }
    const decodedText = decodeHtmlEntities(textBuffer);
    const formatter = getActiveFormatter(scopes, theme);
    output += formatter ? formatter(decodedText) : decodedText;
    textBuffer = "";
  };

  let index = 0;
  while (index < html.length) {
    if (isSpanOpenTagStart(html, index)) {
      const tagEndIndex = html.indexOf(">", index + 5);
      if (tagEndIndex !== -1) {
        // Scope stack mirrors nested highlight.js spans so inner scopes override outer ones.
        flushText();
        const tag = html.slice(index, tagEndIndex + 1);
        const scope = getScopeFromSpanTag(tag);
        scopes.push(scope);
        index = tagEndIndex + 1;
        continue;
      }
    }

    if (html.startsWith(SPAN_CLOSE, index)) {
      flushText();
      scopes.pop();
      index += SPAN_CLOSE.length;
      continue;
    }

    textBuffer += html[index];
    index++;
  }

  flushText();
  return output;
}

/** Highlights code after the caller has selected a registered language. */
export function highlight(code: string, language: string, theme: HighlightTheme): string {
  const { value } = loadHighlightJsRuntime().highlight(code, { language, ignoreIllegals: true });
  return renderHighlightedHtml(value, theme);
}

export function supportsLanguage(name: string): boolean {
  return loadHighlightJsRuntime().getLanguage(name) !== undefined;
}
