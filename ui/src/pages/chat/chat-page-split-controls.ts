import { BALANCE_PANES_REQUEST_EVENT } from "../../lib/split-pane-events.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { balanceLayout, findPane, insertPane } from "./split-layout.ts";

export type ChatPageSplitBindings = {
  layout: () => ChatSplitLayout | undefined;
  presented: () => boolean;
  classicLayout: (sessionKey: string) => ChatSplitLayout;
  classicPaneId: () => string;
  activeSessionKey: () => string | undefined;
  persist: (layout: ChatSplitLayout | undefined) => void;
};

/**
 * Split-view actions offered by the pane header, the layout menu, and the global
 * balance shortcut. Kept out of the chat page so the page stays readable.
 */
export class ChatPageSplitControls {
  constructor(private readonly bindings: ChatPageSplitBindings) {}

  connect(): void {
    window.addEventListener(BALANCE_PANES_REQUEST_EVENT, this.balance);
  }

  disconnect(): void {
    window.removeEventListener(BALANCE_PANES_REQUEST_EVENT, this.balance);
  }

  readonly openSplitView = (): void => {
    const sessionKey = this.bindings.activeSessionKey()?.trim();
    if (sessionKey) {
      const layout = this.bindings.classicLayout(sessionKey);
      this.bindings.persist(insertPane(layout, this.bindings.classicPaneId(), sessionKey, "right"));
    }
  };

  readonly splitRight = (paneId: string): void => this.split(paneId, "right");
  readonly splitDown = (paneId: string): void => this.split(paneId, "down");

  /** Equal shares for every column and stacked pane; only acts on the presented page. */
  readonly balance = (): void => {
    const layout = this.bindings.layout();
    if (layout && this.bindings.presented()) {
      this.bindings.persist(balanceLayout(layout));
    }
  };

  private split(paneId: string, direction: "right" | "down"): void {
    const layout = this.bindings.layout();
    const pane = layout ? findPane(layout, paneId)?.pane : null;
    if (layout && pane) {
      this.bindings.persist(insertPane(layout, paneId, pane.sessionKey, direction));
    }
  }
}
