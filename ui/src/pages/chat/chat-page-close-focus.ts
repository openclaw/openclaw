import { listen } from "../../lib/reactive/listener.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { chatPanesWithin, unboundPanesWithin } from "./chat-pane-elements.ts";
import type { ChatSplitLayout, ChatSplitPane } from "./split-layout-types.ts";

/** Returns keyboard focus only while the closing pane still owns that intent. */
export class ChatPageCloseFocus {
  private pending?: {
    source: Element;
    paneId: string;
    sessionKey: string;
    layout: ChatSplitLayout | undefined;
    href: string;
    stop: () => void;
  };

  constructor(private readonly host: HTMLElement) {}

  clear(): void {
    this.pending?.stop();
    this.pending = undefined;
  }

  capture(paneId: string): Element | null {
    this.clear();
    const source = this.host.ownerDocument.activeElement;
    // Pane refs remain valid while retained siblings change their presentation.
    return source &&
      (chatPanesWithin(this.host).some((pane) => pane.paneId === paneId && pane.contains(source)) ||
        unboundPanesWithin(this.host).some(
          (pane) => pane.dataset.unboundPaneId === paneId && pane.contains(source),
        ))
      ? source
      : null;
  }

  schedule(source: Element, pane: ChatSplitPane, layout: ChatSplitLayout | undefined): void {
    this.pending = {
      source,
      paneId: pane.id,
      sessionKey: pane.sessionKey,
      layout,
      href: window.location.href,
      stop: listen(this.host.ownerDocument, "focusin", () => this.clear()),
    };
  }

  restore(layout: ChatSplitLayout | undefined, retiring: boolean): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const active = this.host.ownerDocument.activeElement;
    if (
      layout !== pending.layout ||
      window.location.href !== pending.href ||
      (active !== pending.source && active !== this.host.ownerDocument.body)
    ) {
      this.clear();
      return;
    }
    // MCP teardown can keep the closing pane mounted across the first render.
    if (retiring) {
      return;
    }
    const pane = chatPanesWithin(this.host).find(
      (candidate) =>
        candidate.paneId === pending.paneId &&
        areUiSessionKeysEquivalent(candidate.sessionKey, pending.sessionKey),
    );
    const target =
      pane?.active && pane.presented
        ? pane.headerElement
        : unboundPanesWithin(this.host).find(
            (candidate) => candidate.dataset.unboundPaneId === pending.paneId,
          );
    if (target) {
      this.clear();
      target.focus({ preventScroll: true });
    }
  }
}
