// One lifecycle owner for interactive Markdown in transcripts and previews.
import { nothing } from "lit";
import { directive, type ElementPart } from "lit/directive.js";
import {
  PresentationAsyncDirective,
  type PresentationBinding,
  type PresentationValue,
} from "../lit/presentation-binding.ts";
import { MarkdownBlocks } from "./markdown-blocks-owner.ts";

export { MarkdownBlocks } from "./markdown-blocks-owner.ts";

class MarkdownBlocksDirective extends PresentationAsyncDirective {
  private root?: HTMLElement;
  private owner?: MarkdownBlocks;

  protected override presentationChanged(binding?: PresentationBinding) {
    if (binding?.isPresented() === false) {
      this.owner?.update(false);
    }
  }

  render(_presented: PresentationValue = true) {
    return nothing;
  }

  override update(part: ElementPart, [presented = true]: [PresentationValue?]) {
    this.updatePresentation(presented);
    const root = part.element instanceof HTMLElement ? part.element : undefined;
    if (root !== this.root) {
      this.owner?.dispose();
      this.root = root;
      this.owner = root ? new MarkdownBlocks(root) : undefined;
    }
    this.owner?.setConnected(this.isConnected);
    this.owner?.update(typeof presented === "boolean" ? presented : presented.isPresented());
    return nothing;
  }

  protected override disconnected(): void {
    super.disconnected();
    this.owner?.setConnected(false);
  }

  protected override reconnected(): void {
    super.reconnected();
    this.owner?.setConnected(true);
  }
}

export const markdownBlocks = directive(MarkdownBlocksDirective);
