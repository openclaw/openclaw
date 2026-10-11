import { nothing } from "lit";
import { directive, type ElementPart } from "lit/directive.js";
import {
  PresentationAsyncDirective,
  type PresentationBinding,
  type PresentationValue,
} from "../lit/presentation-binding.ts";
import { LinkReaderPrefetchOwner } from "./link-reader-prefetch-owner.ts";

// The unported chat thread still supplies Lit connection and presentation events.
class LinkReaderPrefetchDirective extends PresentationAsyncDirective {
  private readonly owner = new LinkReaderPrefetchOwner(() => this.isConnected);

  protected override presentationChanged(binding?: PresentationBinding): void {
    if (binding?.isPresented() === false) {
      this.owner.hide();
    }
  }

  render(_sessionKey: string, _presented: PresentationValue, _connected = true) {
    return nothing;
  }

  override update(
    part: ElementPart,
    [sessionKey, presented, connected = true]: [string, PresentationValue, boolean?],
  ) {
    this.updatePresentation(presented);
    this.owner.update(
      part.element instanceof HTMLElement ? part.element : undefined,
      sessionKey,
      typeof presented === "boolean" ? presented : presented.isPresented(),
      connected,
    );
    return nothing;
  }

  protected override disconnected(): void {
    super.disconnected();
    this.owner.disconnect();
  }

  protected override reconnected(): void {
    super.reconnected();
    this.owner.connect();
  }
}

export const linkReaderPrefetch = directive(LinkReaderPrefetchDirective);
