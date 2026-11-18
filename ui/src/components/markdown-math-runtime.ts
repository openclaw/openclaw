import katex from "katex";
import katexStyles from "katex/dist/katex.min.css?inline";

// Browsers ignore shadow-only @font-face. Register just the pinned stylesheet's
// font declarations in the document; equation presentation stays in each shadow.
const fonts = document.createElement("style");
fonts.textContent = katexStyles.match(/@font-face\s*\{[^}]*\}/gu)?.join("\n") ?? "";
document.head.append(fonts);

const renderedMath = new WeakMap<HTMLElement, { source: string; displayMode: boolean }>();

export function renderMarkdownMath(host: HTMLElement, displayMode: boolean): void {
  const source = host.textContent ?? "";
  const previous = renderedMath.get(host);
  if (previous?.source === source && previous.displayMode === displayMode) {
    return;
  }
  host.classList.toggle("markdown-math-display", displayMode);
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  try {
    const style = document.createElement("style");
    style.textContent =
      katexStyles +
      `
      :host { display: inline-block; max-width: 100%; vertical-align: middle; }
      :host(.markdown-math-display) { display: block; overflow-x: auto; }
      .katex-display { margin: 0; }
    `;
    const content = document.createElement("span");
    katex.render(source, content, {
      displayMode,
      throwOnError: false,
      trust: false,
      // Bound explicit TeX dimensions in messages.
      maxSize: 20,
    });
    root.replaceChildren(style, content);
    renderedMath.set(host, { source, displayMode });
  } catch (error) {
    root.replaceChildren(document.createElement("slot"));
    console.warn("[markdown] Math rendering unavailable:", error);
  }
}
