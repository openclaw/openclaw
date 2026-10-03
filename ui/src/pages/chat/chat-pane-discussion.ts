import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { ChatPaneSessionMenu } from "./chat-pane-session-menu.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import { closeSlot, openSlot } from "./sidebar-layout.ts";

export abstract class ChatPaneDiscussion extends ChatPaneSessionMenu {
  // Probe once per session activation; transient failures stay uncached so the
  // next activation retries instead of permanently hiding the feature.
  protected async probeSessionDiscussion(sessionKey: string) {
    const state = this.state;
    if (
      !state?.connected ||
      !state.client ||
      this.sessionDiscussionStates.has(sessionKey) ||
      // One in-flight probe per key: a rapid A→B→A switch must not start a
      // second probe whose slower twin could later overwrite the fresh result.
      this.sessionDiscussionProbes.has(sessionKey) ||
      !canCallGatewayMethod(
        this.context.gateway.snapshot,
        "session.discussion.info",
        "operator.read",
      )
    ) {
      return;
    }
    const generation = this.connectionGeneration;
    this.sessionDiscussionProbes.add(sessionKey);
    try {
      const info = await state.client.request<SessionDiscussionInfo>("session.discussion.info", {
        sessionKey,
        agentId: resolveChatAgentId(state),
      });
      // A reconnect supersedes in-flight probes; a stale result must not
      // overwrite the new source's cache (e.g. an old "none" hiding the action).
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.sessionDiscussionStates.set(sessionKey, info.state);
      this.requestUpdate();
    } catch {
      // Leave unprobed: the action stays hidden and a later switch retries.
    } finally {
      this.sessionDiscussionProbes.delete(sessionKey);
      // A reconnect during this probe skipped its own probe (the key was
      // still held here); retry now so the new source gets a fresh answer.
      if (
        generation !== this.connectionGeneration &&
        this.state?.sessionKey === sessionKey &&
        !this.sessionDiscussionStates.has(sessionKey)
      ) {
        void this.probeSessionDiscussion(sessionKey);
      }
    }
  }

  protected buildSessionDiscussionPanel(
    state: NonNullable<typeof this.state>,
    sessionKey: string,
  ): SessionDiscussionPanelConfig | null {
    if (
      !state.connected ||
      !state.client ||
      !canCallGatewayMethod(
        this.context.gateway.snapshot,
        "session.discussion.info",
        "operator.read",
      )
    ) {
      return null;
    }
    const canOpen = canCallGatewayMethod(
      this.context.gateway.snapshot,
      "session.discussion.open",
      "operator.write",
    );
    const contentGeneration = this.connectionGeneration;
    const cached = this.sessionDiscussionPanels.get(sessionKey);
    if (cached?.generation === contentGeneration && cached.canOpen === canOpen) {
      cached.config.openUrl = this.sessionDiscussionOpenUrls.get(sessionKey) ?? null;
      return cached.config;
    }
    const request = async (
      method: "session.discussion.info" | "session.discussion.open",
      key: string,
    ) => {
      if (
        contentGeneration !== this.connectionGeneration ||
        !state.connected ||
        !state.client ||
        state.client !== this.context.gateway.snapshot.client ||
        !canCallGatewayMethod(
          this.context.gateway.snapshot,
          method,
          method === "session.discussion.info" ? "operator.read" : "operator.write",
        )
      ) {
        throw new Error(t("chat.sessionDiscussion.disconnected"));
      }
      return state.client.request<SessionDiscussionInfo>(method, {
        sessionKey: key,
        agentId: resolveChatAgentId(state),
      });
    };
    const config: SessionDiscussionPanelConfig = {
      sessionKey,
      canOpen,
      openUrl: this.sessionDiscussionOpenUrls.get(sessionKey) ?? null,
      loadInfo: (key) => request("session.discussion.info", key),
      openDiscussion: (key) => request("session.discussion.open", key),
      onStateChange: (key, discussionState, openUrl) => {
        // Panels created under a previous connection may report late; their
        // state belongs to the old provider and must not touch the new cache.
        if (contentGeneration !== this.connectionGeneration) {
          return;
        }
        this.sessionDiscussionStates.set(key, discussionState);
        const isCurrentSession = state.sessionKey.trim() === key;
        if (isCurrentSession) {
          this.sessionDiscussionOpenUrls.set(key, openUrl);
        }
        if (discussionState === "none") {
          this.sessionDiscussionOpenUrls.delete(key);
        }
        if (discussionState === "none" && isCurrentSession) {
          state.updateSidebarLayout(closeSlot(state.sidebarLayout, "discussion"));
          return;
        }
        state.requestUpdate();
      },
    };
    this.sessionDiscussionPanels.set(sessionKey, {
      generation: contentGeneration,
      canOpen,
      config,
    });
    return config;
  }

  protected openSessionDiscussionSlot(): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    const opened = openSlot(state.sidebarLayout, "discussion");
    const discussionPanel = opened.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "discussion");
    this.commitSidebarLayout(opened);
    if (discussionPanel) {
      state.updateSidebarActivePanel(discussionPanel.id);
    }
    return true;
  }

  protected resolveSessionDiscussionAction(): {
    active: boolean;
    label: string;
    onToggle: () => void;
  } | null {
    const state = this.state;
    const sessionKey = state?.sessionKey.trim() ?? "";
    const known = sessionKey ? this.sessionDiscussionStates.get(sessionKey) : undefined;
    if (
      !state?.connected ||
      !state.client ||
      !sessionKey ||
      known === undefined ||
      known === "none" ||
      !canCallGatewayMethod(
        this.context.gateway.snapshot,
        "session.discussion.info",
        "operator.read",
      )
    ) {
      return null;
    }
    if (!this.buildSessionDiscussionPanel(state, sessionKey)) {
      return null;
    }
    const active = state.sidebarLayout.columns.some((column) =>
      column.panels.some((panel) => panel.slot === "discussion"),
    );
    const label = t(active ? "chat.sessionDiscussion.hide" : "chat.sessionDiscussion.show");
    return {
      active,
      label,
      onToggle: () =>
        active
          ? this.commitSidebarLayout(closeSlot(state.sidebarLayout, "discussion"))
          : this.openSessionDiscussionSlot(),
    };
  }
}
