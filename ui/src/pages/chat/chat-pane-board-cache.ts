import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { resolveSandboxHostUrl } from "../../components/sandbox-host.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import type { BoardSnapshot, BoardWidget } from "../../lib/board/types.ts";
import type { BoardViewCallbacks } from "../../lib/board/view-types.ts";
import {
  prepareBoardSandbox,
  type PreparedBoardSandbox,
} from "../../lib/board/widget-sandbox-prewarm.ts";
import { resolveSessionKey } from "../../lib/sessions/navigation.ts";
import {
  buildAgentMainSessionKey,
  normalizeSessionKeyForUiComparison,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { cacheChatBoardContentHeightAfterHydration } from "./chat-board-snapshot.ts";
import { ChatPaneReplyNavigation } from "./chat-pane-reply-navigation.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";
import { isSidebarSlotVisible } from "./sidebar-layout.ts";

export abstract class ChatPaneBoardCache extends ChatPaneReplyNavigation {
  boardHeightLayout(provider: BoardProvider): BoardViewCallbacks["heightLayout"] {
    const state = this.state;
    if (!state) {
      return undefined;
    }
    const target = this.resolveBoardConversation();
    const scope = gatewayPresentationScope(this.context.gateway);
    const current = () =>
      this.state === state &&
      this.boardProviderLease?.provider === provider &&
      gatewayPresentationScope(this.context.gateway) === scope;
    const read = () =>
      readChatSessionSnapshot(state.chatMessagesBySession, state, target)?.board?.contentHeights;
    return {
      cached: Boolean(read()),
      read: (key) => (current() ? read()?.[key] : undefined),
      write: (key, height) =>
        cacheChatBoardContentHeightAfterHydration(state, target, key, height, current),
    };
  }
  private preparedBoardSandboxes = new Map<string, PreparedBoardSandbox>();

  protected prepareBoardSandboxes(provider: BoardProvider): void {
    if (
      !provider.hasLoadedSnapshot ||
      this.preparedBoardSandboxes.size > 0 ||
      !this.presented ||
      !(
        this.routeFace === "dashboard" ||
        (this.state && isSidebarSlotVisible(this.state.sidebarLayout, "dashboard"))
      ) ||
      typeof Element.prototype.moveBefore !== "function"
    ) {
      return;
    }
    const snapshot = provider.snapshot$.value;
    const activeTab = this.boardActiveTab(snapshot);
    for (const widget of snapshot.widgets
      .filter((entry) => entry.tabId === activeTab)
      .slice(0, 48)) {
      if (
        widget.contentKind !== "html" ||
        widget.grantState === "pending" ||
        widget.grantState === "rejected" ||
        !widget.sandboxUrl ||
        !widget.sandboxPort ||
        !widget.viewTicket
      ) {
        continue;
      }
      try {
        const url = new URL(
          resolveSandboxHostUrl(
            widget.sandboxUrl,
            widget.sandboxPort,
            widget.sandboxOrigin,
            this.context.gateway.connection.gatewayUrl,
            window.location.origin,
          ),
        );
        url.hash = `theme=${document.documentElement.dataset.themeMode === "light" ? "light" : "dark"}`;
        this.preparedBoardSandboxes.set(widget.name, prepareBoardSandbox(url.href));
      } catch {
        // Invalid cached URLs still belong to the widget's render error boundary.
      }
    }
  }

  takePreparedBoardSandbox(widget: BoardWidget, url: string): PreparedBoardSandbox | undefined {
    const prepared = this.preparedBoardSandboxes.get(widget.name);
    this.preparedBoardSandboxes.delete(widget.name);
    if (prepared?.frame.src === url) {
      return prepared;
    }
    prepared?.dispose();
    return undefined;
  }
  protected resolveBoardConversation() {
    return resolveUiConversationIdentity(
      {
        assistantAgentId: this.state?.assistantAgentId,
        agentsList: this.state?.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      },
      this.state?.sessionKey || this.sessionKey,
    );
  }

  protected resolveBoardSessionKey(snapshotSessionKey = ""): string {
    const resolved = resolveSessionKey(
      snapshotSessionKey || this.state?.sessionKey || this.sessionKey,
      this.context?.gateway.snapshot.hello,
    );
    const normalized = normalizeSessionKeyForUiComparison(resolved);
    return normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
  }

  protected boardActiveTab(snapshot: BoardSnapshot): string {
    const sessionKey = this.resolveBoardSessionKey(snapshot.sessionKey);
    const saved = this.context.theme.settings.boardSessionViews?.[sessionKey];
    const savedTab = snapshot.tabs.some((tab) => tab.tabId === saved?.activeTabId)
      ? saved?.activeTabId
      : undefined;
    return savedTab ?? snapshot.tabs[0]?.tabId ?? snapshot.widgets[0]?.tabId ?? "";
  }

  protected releasePreparedBoardSandboxes(): void {
    for (const prepared of this.preparedBoardSandboxes.values()) {
      prepared.dispose();
    }
    this.preparedBoardSandboxes.clear();
  }
}
