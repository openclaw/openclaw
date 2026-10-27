import { resolveArtifactDownloadSource } from "../../api/artifact-download.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { markdownSessionPublicOrigin } from "../../components/markdown-session-links.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/navigation.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, resolveChatAvatarUrl } from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view.tsx";
import { resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";
import {
  createChatDisplayFacts,
  createChatWidgetLayout,
  projectChatAvatarSources,
  readChatSessionSnapshot,
} from "./session-message-cache.ts";

type ResourceProps = Pick<
  ChatProps,
  | "mediaPolicyEpoch"
  | "mediaReadAllowed"
  | "connectionEpoch"
  | "embedSandboxMode"
  | "allowExternalEmbedUrls"
  | "fetchLinkFavicon"
  | "assistantAttachmentAuthToken"
  | "resolveArtifactDownload"
  | "basePath"
  | "sessionPublicOrigin"
  | "resourceBasePath"
  | "fullMessageAgentId"
  | "widgetLayout"
  | "displayFacts"
  | "assistantName"
  | "assistantAvatar"
  | "assistantAvatarUrl"
  | "assistantAvatarSource"
  | "senderAgentAvatars"
>;

export function createChatPaneResourceProps() {
  const widgetLayout = createChatWidgetLayout();
  return (state: ChatPageHost, context: ApplicationContext): ResourceProps => {
    const mediaReadAllowed = state.connected && !state.isRouteSessionPending?.();
    const target = {
      sessionKey: state.sessionKey,
      ...scopedAgentParamsForSession(state, state.sessionKey),
    };
    const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, target);
    const avatarSources =
      snapshot?.sessionId === state.currentSessionId ? snapshot?.avatarSources : undefined;
    return {
      fullMessageAgentId: target.agentId,
      widgetLayout: widgetLayout(state.chatMessagesBySession, state, target),
      displayFacts: createChatDisplayFacts(state.chatMessagesBySession, state, target),
      assistantName: state.assistantName,
      assistantAvatar: state.assistantAvatar,
      assistantAvatarUrl: resolveChatAvatarUrl(state),
      assistantAvatarSource:
        state.chatAvatarUrl ?? avatarSources?.[resolveChatAgentId(state) ?? ""],
      senderAgentAvatars: state.senderAgentAvatars?.size
        ? state.senderAgentAvatars
        : projectChatAvatarSources(avatarSources),
      mediaReadAllowed,
      mediaPolicyEpoch: state.mediaPolicyEpoch,
      connectionEpoch: state.connectionEpoch,
      embedSandboxMode: state.embedSandboxMode,
      allowExternalEmbedUrls: state.allowExternalEmbedUrls,
      fetchLinkFavicon: mediaReadAllowed ? resolveChatLinkFaviconFetcher(state) : undefined,
      assistantAttachmentAuthToken: mediaReadAllowed ? resolveControlUiAuthToken(state) : null,
      resolveArtifactDownload: (params, signal) =>
        resolveArtifactDownloadSource(state, params, signal),
      basePath: state.basePath,
      sessionPublicOrigin: markdownSessionPublicOrigin(context),
      resourceBasePath: state.resourceBasePath,
    };
  };
}
