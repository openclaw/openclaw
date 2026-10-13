import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";
import type { ChatSplitLayout, ChatSplitPane } from "./split-layout-types.ts";

/** Returns keyboard focus only while the closing pane still owns that intent. */
export class ChatPageCloseFocus {
  private pending?: {
    source: Element;
    paneId: string;
    sessionKey: string;
    layout: ChatSplitLayout | undefined;
    href: string;
    abort: AbortController;
  };

  constructor(private readonly host: HTMLElement) {}

  clear(): void {
    this.pending?.abort.abort();
    this.pending = undefined;
  }

  capture(paneId: string): Element | null {
    this.clear();
    const source = this.host.ownerDocument.activeElement;
    return source &&
      ([...this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].some(
        (pane) => pane.paneId === paneId && pane.contains(source),
      ) ||
        [...this.host.querySelectorAll<HTMLElement>("[data-unbound-pane-id]")].some(
          (pane) => pane.dataset.unboundPaneId === paneId && pane.contains(source),
        ))
      ? source
      : null;
  }

  schedule(source: Element, pane: ChatSplitPane, layout: ChatSplitLayout | undefined): void {
    const abort = new AbortController();
    this.pending = {
      source,
      paneId: pane.id,
      sessionKey: pane.sessionKey,
      layout,
      href: window.location.href,
      abort,
    };
    this.host.ownerDocument.addEventListener("focusin", () => this.clear(), {
      signal: abort.signal,
    });
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
    const pane = [...this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].find(
      (candidate) =>
        candidate.paneId === pending.paneId &&
        areUiSessionKeysEquivalent(candidate.sessionKey, pending.sessionKey),
    );
    const target =
      pane?.active && pane.presented
        ? pane.querySelector<HTMLElement>(".chat-pane__header")
        : [...this.host.querySelectorAll<HTMLElement>("[data-unbound-pane-id]")].find(
            (candidate) => candidate.dataset.unboundPaneId === pending.paneId,
          );
    if (target) {
      this.clear();
      target.focus({ preventScroll: true });
    }
  }
}
