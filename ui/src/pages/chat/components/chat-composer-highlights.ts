import { noChange } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import "../../../styles/chat/composer-highlights.css";

export type ComposerHighlightRange = { start: number; end: number };
type ValueRange = AbstractRange & { disconnect(): void };

// OpaqueRange shipped before its DOM library declarations. No polyfill: native
// selection, editing and plain text remain unchanged in unsupported browsers.
declare global {
  interface HTMLTextAreaElement {
    createValueRange?: (start: number, end: number) => ValueRange;
  }
}

const highlightName = "openclaw-composer-token";
type ResolveRanges = (value: string) => readonly ComposerHighlightRange[];

class ComposerHighlights extends AsyncDirective {
  private textarea?: HTMLTextAreaElement;
  private resolveRanges?: ResolveRanges;
  private ranges: ValueRange[] = [];
  private highlight?: Highlight;

  render(_resolveRanges: ResolveRanges) {
    return noChange;
  }

  override update(part: ElementPart, [resolveRanges]: [ResolveRanges]) {
    if (this.textarea !== part.element) {
      this.disconnected();
      if (!(part.element instanceof HTMLTextAreaElement)) {
        throw new Error("composerHighlights requires a native textarea");
      }
      this.textarea = part.element;
      // This element directive follows the owner's input listener in both
      // templates, so annotations are committed before decoration is refreshed.
      this.textarea.addEventListener("input", this.refresh);
    }
    this.resolveRanges = resolveRanges;
    this.refresh();
    return noChange;
  }

  private clear() {
    for (const range of this.ranges) {
      this.highlight?.delete(range);
      range.disconnect();
    }
    this.ranges = [];
    if (this.highlight?.size === 0 && CSS.highlights.get(highlightName) === this.highlight) {
      CSS.highlights.delete(highlightName);
    }
    this.highlight = undefined;
  }

  private refresh = () => {
    this.clear();
    const textarea = this.textarea;
    if (
      !this.isConnected ||
      !textarea?.createValueRange ||
      typeof Highlight === "undefined" ||
      typeof CSS === "undefined" ||
      !CSS.highlights
    ) {
      return;
    }
    const ranges = this.resolveRanges?.(textarea.value) ?? [];
    if (ranges.length === 0) {
      return;
    }
    this.highlight = CSS.highlights.get(highlightName) ?? new Highlight();
    for (const { start, end } of ranges) {
      const range = textarea.createValueRange(start, end);
      this.ranges.push(range);
      this.highlight.add(range);
    }
    CSS.highlights.set(highlightName, this.highlight);
  };

  override disconnected() {
    this.textarea?.removeEventListener("input", this.refresh);
    this.clear();
  }

  override reconnected() {
    this.textarea?.addEventListener("input", this.refresh);
    this.refresh();
  }
}

export const composerHighlights = directive(ComposerHighlights);
