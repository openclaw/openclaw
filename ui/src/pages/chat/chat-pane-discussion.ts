import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { ChatDiscussionPanelSource } from "./chat-pane-panel-source.ts";
import { ChatPaneSessionMenu } from "./chat-pane-session-menu.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { closeSlot, openSlot } from "./sidebar-layout.ts";

registerChatSessionEnglish();

export abstract class ChatPaneDiscussion extends ChatPaneSessionMenu {
  // Probe once per session activation; transient failures stay uncached so the
  // next activation retries instead of permanently hiding the feature.
  protected async probeSessionDiscussion(sessionKey: string) {
    const state = this.state;
    if (
      !state?.connected ||
      !state.client ||
      this.sessionDiscussion.snapshot.states.has(sessionKey) ||
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
      this.sessionDiscussion.record(sessionKey, info.state);
    } catch {
      // Leave unprobed: the action stays hidden and a later switch retries.
    } finally {
      this.sessionDiscussionProbes.delete(sessionKey);
      // A reconnect during this probe skipped its own probe (the key was
      // still held here); retry now so the new source gets a fresh answer.
      if (
        generation !== this.connectionGeneration &&
        this.state?.sessionKey === sessionKey &&
        !this.sessionDiscussion.snapshot.states.has(sessionKey)
      ) {
        void this.probeSessionDiscussion(sessionKey);
      }
    }
  }

  protected sessionDiscussionSource(
    state: NonNullable<typeof this.state>,
    sessionKey: string,
  ): ChatDiscussionPanelSource | null {
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
    return {
      owner: this,
      state,
      sessionKey,
      generation: this.connectionGeneration,
      canOpen: canCallGatewayMethod(
        this.context.gateway.snapshot,
        "session.discussion.open",
        "operator.write",
      ),
      openUrl: this.sessionDiscussion.snapshot.openUrls.get(sessionKey) ?? null,
    };
  }

  protected openSessionDiscussionSlot(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const opened = openSlot(state.sidebarLayout, "discussion");
    const discussionPanel = opened.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "discussion");
    this.commitSidebarLayout(opened);
    if (discussionPanel) {
      state.updateSidebarActivePanel(discussionPanel.id);
    }
  }

  protected resolveSessionDiscussionAction() {
    const state = this.state;
    const sessionKey = state?.sessionKey.trim() ?? "";
    const known = sessionKey ? this.sessionDiscussion.snapshot.states.get(sessionKey) : undefined;
    if (
      !state ||
      !sessionKey ||
      known === undefined ||
      known === "none" ||
      !this.sessionDiscussionSource(state, sessionKey)
    ) {
      return null;
    }
    const active = state.sidebarLayout.columns.some((column) =>
      column.panels.some((panel) => panel.slot === "discussion"),
    );
    return {
      active,
      label: t(active ? "chat.sessionDiscussion.hide" : "chat.sessionDiscussion.show"),
      onToggle: () =>
        active
          ? this.commitSidebarLayout(closeSlot(state.sidebarLayout, "discussion"))
          : this.openSessionDiscussionSlot(),
    };
  }
}
