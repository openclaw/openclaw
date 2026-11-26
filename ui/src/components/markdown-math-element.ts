// This non-JSX utility module owns both typesetting and its stylesheet.
// Share settled failures as well, so multiple leaves do not start retry storms.
let runtime: ReturnType<typeof loadMath> | undefined;
const renderedSources = new WeakMap<Node, { source: string; literal: string }>();

export function getRenderedMarkdownMathSource(node: Node | null) {
  return node ? renderedSources.get(node) : undefined;
}

export function cloneWithRenderedMarkdownMath<T extends HTMLElement>(element: T): T {
  const clone = element.ownerDocument.importNode(element, true);
  const originals = element.getElementsByTagName("openclaw-markdown-math");
  const copies = clone.getElementsByTagName("openclaw-markdown-math");
  for (let index = 0; index < originals.length; index += 1) {
    const source = renderedSources.get(originals[index]!);
    if (source) {
      renderedSources.set(copies[index]!, source);
    }
  }
  return clone;
}

async function loadMath() {
  try {
    const { applyMarkdownMathStyles, renderMarkdownMath } =
      await import("./markdown-math.runtime.ts");
    return { applyMarkdownMathStyles, renderMarkdownMath };
  } catch {
    return null;
  }
}

// Markdown parsing also runs without a DOM (Node tests, non-browser callers); the
// leaf element exists only where custom elements do, and parsed output stays
// readable source text until a connected leaf upgrades it.
function defineMarkdownMathElement(): void {
  if (typeof customElements === "undefined" || customElements.get("openclaw-markdown-math")) {
    return;
  }

  class MarkdownMathElement extends HTMLElement {
    private generation = 0;

    connectedCallback(): void {
      if (renderedSources.has(this)) {
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
        const open = displayMode ? "$$" : "\\(";
        const close = displayMode ? "$$" : "\\)";
        if (!literal.startsWith(open) || !literal.endsWith(close)) {
          return;
        }
        const source = literal.slice(open.length, -close.length);
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
            renderedSources.set(this, { source, literal });
          }
        });
      });
    }

    disconnectedCallback(): void {
      this.generation += 1;
    }
  }

  customElements.define("openclaw-markdown-math", MarkdownMathElement);
}

defineMarkdownMathElement();
