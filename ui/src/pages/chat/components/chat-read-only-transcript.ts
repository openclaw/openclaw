import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

export function renderReadOnlyTranscript(params: {
  chat: ChatThreadProps;
  messages: unknown[];
  paneId: string;
  sessionKey: string;
  transcript: ChatTranscriptController;
  providerOwned?: boolean;
}) {
  const { chat } = params;
  return renderChatThread(
    {
      paneId: params.paneId,
      sessionKey: params.sessionKey,
      selectedSession: chat.selectedSession,
      announceTranscript: false,
      loading: false,
      messages: params.messages,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      runId: null,
      queue: [],
      showThinking: params.providerOwned ? false : chat.showThinking,
      showToolCalls: chat.showToolCalls,
      persistCommentary: chat.persistCommentary,
      sessions: params.providerOwned ? null : chat.sessions,
      sessionHost: params.providerOwned ? undefined : chat.sessionHost,
      assistantName: chat.assistantName,
      assistantAvatar: chat.assistantAvatar,
      assistantAvatarUrl: chat.assistantAvatarUrl,
      userId: chat.userId,
      userName: chat.userName,
      userAvatar: chat.userAvatar,
      avatarPlacement: chat.avatarPlacement,
      // Peer authors link to their Activity feed here exactly as in the live transcript.
      personActivity: chat.personActivity,
      basePath: chat.basePath,
      fullMessageAgentId: params.providerOwned ? undefined : chat.fullMessageAgentId,
      loadFullAssistantMessage: params.providerOwned ? undefined : chat.loadFullAssistantMessage,
      mediaPolicyEpoch: chat.mediaPolicyEpoch,
      assistantAttachmentAuthToken: params.providerOwned
        ? undefined
        : chat.assistantAttachmentAuthToken,
      resolveArtifactDownload: params.providerOwned ? undefined : chat.resolveArtifactDownload,
      canvasPluginSurfaceUrl: params.providerOwned ? undefined : chat.canvasPluginSurfaceUrl,
      embedSandboxMode: chat.embedSandboxMode,
      allowExternalEmbedUrls: chat.allowExternalEmbedUrls,
      fetchLinkFavicon: chat.fetchLinkFavicon,
      autoExpandToolCalls: chat.autoExpandToolCalls,
      onRequestUpdate: chat.onRequestUpdate ?? (() => {}),
      onDraftChange: () => undefined,
      onSend: () => undefined,
    },
    params.transcript,
  );
}
