// This non-JSX utility module owns both typesetting and its stylesheet.
// Share settled failures as well, so multiple leaves do not start retry storms.
let runtime: ReturnType<typeof loadMath> | undefined;

async function loadMath() {
  try {
    const { applyMarkdownMathStyles, renderMarkdownMath } =
      await import("./markdown-math.runtime.ts");
    return { applyMarkdownMathStyles, renderMarkdownMath };
  } catch {
    return null;
  }
}

class MarkdownMathElement extends HTMLElement {
  private generation = 0;
  private rendered = false;

  connectedCallback(): void {
    if (this.rendered) {
      return;
    }
    const generation = ++this.generation;
    // Parser/DOM insertion can connect a leaf before its text children arrive.
    queueMicrotask(() => {
      if (!this.isConnected || generation !== this.generation) {
        return;
      }
      const literal = this.textContent ?? "";
      const displayMode = this.dataset.display === "true";
      const delimiter = displayMode ? "$$" : "$";
      if (!literal.startsWith(delimiter) || !literal.endsWith(delimiter)) {
        return;
      }
      const source = literal.slice(delimiter.length, -delimiter.length);
      if (!source) {
        return;
      }
      void (runtime ??= loadMath()).then((loaded) => {
        if (
          !loaded ||
          !this.isConnected ||
          generation !== this.generation ||
          this.textContent !== literal ||
          (this.dataset.display === "true") !== displayMode
        ) {
          return;
        }
        loaded.applyMarkdownMathStyles(this.getRootNode());
        const fragment = loaded.renderMarkdownMath(source, displayMode);
        if (fragment.childNodes.length) {
          // Only sanitized generated nodes enter the light DOM. Source remains
          // readable on load/render failure; detached/replaced leaves never commit.
          this.replaceChildren(fragment);
          this.rendered = true;
        }
      });
    });
  }

  disconnectedCallback(): void {
    this.generation += 1;
  }
}

if (!customElements.get("openclaw-markdown-math")) {
  customElements.define("openclaw-markdown-math", MarkdownMathElement);
}
