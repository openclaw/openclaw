import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { CHAT_COMPOSER_TEXTAREA_SELECTOR } from "../chat-pane-shared.ts";

class QueueEditFocusDirective extends AsyncDirective {
  private row: Element | undefined;

  render() {
    return nothing;
  }

  override update(part: ElementPart) {
    this.row = part.element;
    return nothing;
  }

  protected override disconnected(): void {
    const row = this.row;
    if (!row) {
      return;
    }
    const document = row.ownerDocument;
    const focused = document.activeElement;
    if (!focused || !row.contains(focused)) {
      return;
    }
    const composer = row
      .closest(".agent-chat__composer-shell")
      ?.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR);
    // Lit disconnects before removing the focused editor. Save also replaces
    // the keyed row, so the same composer's textarea is the stable destination.
    queueMicrotask(() => {
      if (this.isConnected || focused.isConnected || document.activeElement !== document.body) {
        return;
      }
      if (composer?.isConnected && composer.checkVisibility()) {
        composer.focus({ preventScroll: true });
      }
    });
  }
}

export const queueEditFocus = directive(QueueEditFocusDirective);
