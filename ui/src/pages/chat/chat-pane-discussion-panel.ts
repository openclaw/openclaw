import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { ChatDiscussionPanelSource } from "./chat-pane-panel-source.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.tsx";
import { closeSlot } from "./sidebar-layout.ts";

/** The cache and late-result checks stay bound to the retained connection owner. */
export function buildChatDiscussionPanel({
  owner,
  state,
  sessionKey,
  generation: contentGeneration,
  canOpen,
  openUrl,
}: ChatDiscussionPanelSource): SessionDiscussionPanelConfig {
  const cached = owner.sessionDiscussionPanels.get(sessionKey);
  if (cached?.generation === contentGeneration && cached.canOpen === canOpen) {
    cached.config.openUrl = openUrl;
    return cached.config;
  }
  const request = async (
    method: "session.discussion.info" | "session.discussion.open",
    key: string,
  ) => {
    if (
      contentGeneration !== owner.connectionGeneration ||
      !state.connected ||
      !state.client ||
      state.client !== owner.context.gateway.snapshot.client ||
      !canCallGatewayMethod(
        owner.context.gateway.snapshot,
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
    openUrl,
    loadInfo: (key) => request("session.discussion.info", key),
    openDiscussion: (key) => request("session.discussion.open", key),
    onStateChange: (key, discussionState, discussionUrl) => {
      // Panels created under a previous connection may report late; their
      // state belongs to the old provider and must not touch the new cache.
      if (contentGeneration !== owner.connectionGeneration) {
        return;
      }
      const isCurrentSession = state.sessionKey.trim() === key;
      owner.sessionDiscussion.record(
        key,
        discussionState,
        isCurrentSession ? discussionUrl : undefined,
      );
      if (discussionState === "none" && isCurrentSession) {
        state.updateSidebarLayout(closeSlot(state.sidebarLayout, "discussion"));
      }
    },
  };
  if (contentGeneration === owner.connectionGeneration) {
    owner.sessionDiscussionPanels.set(sessionKey, {
      generation: contentGeneration,
      canOpen,
      config,
    });
  }
  return config;
}
