// Share settled failures as well, so multiple leaves do not start retry storms.
let runtime: ReturnType<typeof loadMath> | undefined;
const renderedSources = new WeakMap<Node, { source: string; literal: string }>();

async function loadMath() {
  try {
    return (await import("./markdown-math.runtime.ts")).typesetMarkdownMath;
  } catch {
    return null;
  }
}

export function getRenderedMarkdownMathSource(node: Node | null) {
  return node ? renderedSources.get(node) : undefined;
}

export function rememberRenderedMarkdownMathSource(
  node: Node,
  source: { source: string; literal: string },
): void {
  renderedSources.set(node, source);
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
        if (literal.length <= 4) {
          return;
        }
        const displayMode = this.dataset.display === "true";
        void (runtime ??= loadMath()).then((typesetMarkdownMath) => {
          if (generation === this.generation) {
            typesetMarkdownMath?.(this, literal, displayMode);
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
