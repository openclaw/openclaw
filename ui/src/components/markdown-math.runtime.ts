import DOMPurify from "dompurify";
import { renderToString } from "katex";
import { markdownMathSanitizer } from "./markdown-math-sanitizer.ts";
import mathStyles from "katex/dist/katex.min.css?inline";

// One lazy sheet serves light-DOM Markdown and shadow-root file previews.
// Inline CSS stays in the async chunk; adopting it synchronously precedes typesetting.
let stylesheet: CSSStyleSheet | undefined;

export function applyMarkdownMathStyles(root: Node): void {
  if (!stylesheet) {
    stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(mathStyles);
  }
  for (const target of root instanceof ShadowRoot ? [document, root] : [document]) {
    if (!target.adoptedStyleSheets.includes(stylesheet)) {
      target.adoptedStyleSheets = [...target.adoptedStyleSheets, stylesheet];
    }
  }
}

const sanitizer = DOMPurify(window);
const sanitizeOptions = {
  RETURN_DOM_FRAGMENT: true as const,
  ALLOWED_TAGS: ["span", ...markdownMathSanitizer.tags],
  ALLOWED_ATTR: ["class", "title", ...markdownMathSanitizer.attrs],
};

function renderMath(source: string, displayMode: boolean): string {
  try {
    return (
      renderToString(source, {
        displayMode,
        output: "htmlAndMathml",
        strict: "ignore",
        throwOnError: false,
        trust: false,
        maxExpand: 1000,
        maxSize: 10,
      })
        // KaTeX's source annotation is redundant for our accessible MathML
        // branch and would echo untrusted command arguments into the DOM.
        .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/gu, "")
    );
  } catch {
    // Keep malformed or unexpectedly expensive input visible as literal text.
    return "";
  }
}

export function renderMarkdownMath(source: string, displayMode: boolean): DocumentFragment {
  return sanitizer.sanitize(renderMath(source, displayMode), sanitizeOptions);
}
