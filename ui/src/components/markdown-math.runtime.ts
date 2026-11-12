import DOMPurify from "dompurify";
import { renderToString } from "katex";
import { markdownMathSanitizer } from "./markdown-math-sanitizer.ts";
import mathStyles from "katex/dist/katex.min.css?inline";

const displayMathLayout = `
openclaw-markdown-math[data-display="true"] {
  display: block;
  max-width: 100%;
  overflow: auto hidden;
  /* KaTeX lays math out left to right; keep the scroll origin and edge fades aligned. */
  direction: ltr;
}
openclaw-markdown-math[data-display="true"] > .katex-display {
  width: max-content;
  min-width: 100%;
}
/* Like Markdown tables, fade the clipped edges of an overflowing equation. Equations
   that fit have no scroll range, so the timeline stays inactive and nothing is masked;
   engines without scroll timelines keep their native scrollbar. */
@supports (animation-timeline: scroll()) {
  openclaw-markdown-math[data-display="true"] {
    animation: openclaw-math-overflow linear both;
    animation-timeline: scroll(self inline);
  }
  /* The mask would also clip the outside focus ring, so keyboard focus drops the fade. */
  openclaw-markdown-math[data-display="true"]:focus-visible {
    animation: none;
  }
}
@keyframes openclaw-math-overflow {
  0%, 1% { mask-image: linear-gradient(to right, black calc(100% - 28px), transparent); }
  2%, 98% {
    mask-image: linear-gradient(to right, transparent, black 28px, black calc(100% - 28px), transparent);
  }
  99%, 100% { mask-image: linear-gradient(to right, transparent, black 28px); }
}
`;

// One lazy sheet serves light-DOM Markdown and shadow-root file previews.
// Inline CSS stays in the async chunk; adopting it synchronously precedes typesetting.
let stylesheet: CSSStyleSheet | undefined;

export function applyMarkdownMathStyles(root: Node): void {
  if (!stylesheet) {
    stylesheet = new CSSStyleSheet();
    // Intrinsic display width keeps both ends reachable; short equations stay centered.
    stylesheet.replaceSync(mathStyles + displayMathLayout);
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
