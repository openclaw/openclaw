import { guard } from "lit/directives/guard.js";
import type { RouteRenderContext } from "../../app-routes.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { i18n, t } from "../../i18n/index.ts";
import { definePage } from "../../router/index.ts";
import {
  clearChatHistory,
  hasAbortableSessionRun,
  refreshChat,
  refreshChatCommands,
  scopedAgentParamsForSession,
} from "../../ui/app-chat.ts";
import {
  createChatSession,
  dismissChatError,
  dismissRealtimeTalkError,
  isCurrentChatSessionArchived,
  openCurrentSessionCheckpoints,
  renderChatControls,
  resolveAssistantAttachmentAuthToken,
  switchChatSession,
} from "../../ui/app-render.helpers.ts";
import { scheduleChatScroll } from "../../ui/app-scroll.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { buildAgentMainSessionKey } from "../../ui/session-key.ts";
import { renderChat, resetChatViewState } from "../../ui/views/chat.ts";
import { loadChatPage } from "../loaders.ts";
import { resolveChatAgentId, resolveChatAvatarUrl } from "./avatar.ts";
import { chatSessionLoaderDeps } from "./loader-deps.ts";
import { createSessionWorkspaceProps } from "./session-workspace.ts";

type ChatLoadContext = { host: SettingsHost; app: SettingsAppHost };
type ChatRenderContext = RouteRenderContext;

function renderGuardedChatControls(state: AppViewState, navigate: RouteRenderContext["navigate"]) {
  return guard(
    [
      state.sessionKey,
      state.connected,
      state.client,
      state.onboarding,
      state.chatManualRefreshInFlight,
      state.chatLoading,
      state.chatSending,
      state.chatStream,
      state.chatRunId,
      state.chatMobileControlsOpen,
      state.sessionsHideCron ?? true,
      state.sessionsResult,
      state.sessionsShowArchived,
      state.agentsList,
      state.chatModelOverrides,
      state.chatModelSwitchPromises,
      state.chatModelsLoading,
      state.chatModelCatalog,
      state.modelAuthStatusResult,
      state.settings.chatShowThinking,
      state.settings.chatShowToolCalls,
      state.settings.chatAutoScroll,
      state.chatSessionPickerOpen,
      state.chatSessionPickerSurface,
      state.chatSessionPickerQuery,
      state.chatSessionPickerAppliedQuery,
      state.chatSessionPickerLoading,
      state.chatSessionPickerError,
      state.chatSessionPickerResult,
      state.sessionSwitchNotice?.id ?? null,
      state.sessionSwitchNotice?.text ?? null,
      state.sessionSwitchFlashKey,
      i18n.getLocale(),
    ],
    () => renderChatControls(state, navigate),
  );
}

export const page = definePage({
  id: "chat",
  path: "/chat",
  loaderDeps: (_context: ChatLoadContext, location) => chatSessionLoaderDeps(location),
  loader: async ({ host, app }: ChatLoadContext, options) => {
    if (!options.revalidating) {
      host.chatHasAutoScrolled = false;
    }
    await loadChatPage(host, app);
  },
  onLeave: () => {
    resetChatViewState();
  },
  component: () => ({
    shell: "chat" as const,
    header: true,
    render: ({ state, navigate }: ChatRenderContext) => {
      const chatSessionArchived = isCurrentChatSessionArchived(state);
      const switchSession = (sessionKey: string) => {
        switchChatSession(state, sessionKey);
        navigate("chat", { history: "none" });
      };
      return renderChat({
        sessionKey: state.sessionKey,
        onSessionKeyChange: switchSession,
        thinkingLevel: state.chatThinkingLevel,
        showThinking: state.onboarding ? false : state.settings.chatShowThinking,
        showToolCalls: state.onboarding ? true : state.settings.chatShowToolCalls,
        loading: state.chatLoading,
        sending: state.chatSending,
        compactionStatus: state.compactionStatus,
        fallbackStatus: state.fallbackStatus,
        assistantAvatarUrl: resolveChatAvatarUrl(state),
        messages: state.chatMessages,
        sideResult: state.chatSideResult,
        toolMessages: state.chatToolMessages,
        streamSegments: state.chatStreamSegments,
        stream: state.chatStream,
        streamStartedAt: state.chatStreamStartedAt,
        draft: state.chatMessage,
        queue: state.chatQueue,
        realtimeTalkActive: state.realtimeTalkActive,
        realtimeTalkStatus: state.realtimeTalkStatus,
        realtimeTalkDetail: state.realtimeTalkDetail,
        realtimeTalkTranscript: state.realtimeTalkTranscript,
        realtimeTalkConversation: state.realtimeTalkConversation,
        realtimeTalkOptionsOpen: state.realtimeTalkOptionsOpen,
        realtimeTalkOptions: state.realtimeTalkOptions,
        realtimeTalkCatalogProviders: state.realtimeTalkCatalogProviders,
        connected: state.connected,
        canSend: state.connected && !chatSessionArchived,
        disabledReason: !state.connected
          ? t("chat.disconnected")
          : chatSessionArchived
            ? t("chat.archivedSessionDisabled")
            : null,
        error: state.lastError,
        runStatus: state.chatRunStatus,
        onDismissError: () => dismissChatError(state),
        onDismissRealtimeTalkError: () => dismissRealtimeTalkError(state),
        sessions: state.sessionsResult,
        composerControls: renderGuardedChatControls(state, navigate),
        sessionWorkspace: createSessionWorkspaceProps(state),
        onRefresh: () => {
          state.chatSideResult = null;
          state.resetToolStream();
          void refreshChat(state, { awaitHistory: true, scheduleScroll: false });
        },
        onChatScroll: (event) => state.handleChatScroll(event),
        getDraft: () => state.chatMessage,
        onDraftChange: (next) => state.handleChatDraftChange(next),
        onRequestUpdate: (state as AppViewState & { requestUpdate?: () => void }).requestUpdate,
        onHistoryKeydown: (input) => state.handleChatInputHistoryKey(input),
        onSlashIntent: () => refreshChatCommands(state).finally(() => state.requestUpdate?.()),
        showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
        onScrollToBottom: () => state.scrollToBottom(),
        attachments: state.chatAttachments,
        onAttachmentsChange: (next) => (state.chatAttachments = next),
        onSend: () => void state.handleSendChat(),
        onCompact: () => void state.handleSendChat("/compact", { restoreDraft: true }),
        onOpenSessionCheckpoints: () => openCurrentSessionCheckpoints(state, navigate),
        onToggleRealtimeTalk: () => void state.toggleRealtimeTalk(),
        onToggleRealtimeTalkOptions: () => {
          state.realtimeTalkOptionsOpen = !state.realtimeTalkOptionsOpen;
          if (state.realtimeTalkOptionsOpen) {
            void state.fetchRealtimeTalkCatalog();
          }
        },
        onRealtimeTalkOptionsChange: (next) => state.updateRealtimeTalkOptions(next),
        canAbort: hasAbortableSessionRun(state),
        onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
        onQueueRemove: (id) => state.removeQueuedMessage(id),
        onQueueRetry: (id) => void state.retryQueuedChatMessage(id),
        onQueueSteer: (id) => void state.steerQueuedChatMessage(id),
        onDismissSideResult: () => (state.chatSideResult = null),
        replyTarget: state.chatReplyTarget ?? null,
        onClearReply: () => {
          state.chatReplyTarget = null;
          state.requestUpdate?.();
        },
        onSetReply: (target) => {
          state.chatReplyTarget = target;
          state.requestUpdate?.();
        },
        onNewSession: () =>
          void createChatSession(state, { source: "user" }).then((created) => {
            if (created) {
              navigate("chat", { history: "none" });
            }
          }),
        onClearHistory: () => void clearChatHistory(state),
        agentsList: state.agentsList,
        currentAgentId: resolveChatAgentId(state),
        fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
        onAgentChange: (agentId) => switchSession(buildAgentMainSessionKey({ agentId })),
        onNavigateToAgent: () => {
          state.agentsSelectedId = state.assistantAgentId;
          navigate("agents");
        },
        onSessionSelect: switchSession,
        sidebarOpen: state.sidebarOpen,
        sidebarContent: state.sidebarContent,
        sidebarError: state.sidebarError,
        splitRatio: state.splitRatio,
        canvasPluginSurfaceUrl: state.hello?.pluginSurfaceUrls?.canvas ?? null,
        onOpenSidebar: (content) => state.handleOpenSidebar(content),
        onCloseSidebar: () => state.handleCloseSidebar(),
        onSplitRatioChange: (ratio) => state.handleSplitRatioChange(ratio),
        assistantName: state.assistantName,
        assistantAvatar: state.assistantAvatar,
        userName: state.userName ?? null,
        userAvatar: state.userAvatar ?? null,
        localMediaPreviewRoots: state.localMediaPreviewRoots,
        embedSandboxMode: state.embedSandboxMode,
        allowExternalEmbedUrls: state.allowExternalEmbedUrls,
        assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state),
        basePath: state.basePath ?? "",
      });
    },
    onStateChange: ({ state }: ChatRenderContext, changed: ReadonlyMap<PropertyKey, unknown>) => {
      if (state.chatManualRefreshInFlight) {
        return;
      }
      if (
        !changed.has("chatMessages") &&
        !changed.has("chatToolMessages") &&
        !changed.has("chatStream") &&
        !changed.has("chatLoading") &&
        !changed.has("realtimeTalkConversation")
      ) {
        return;
      }
      const forcedByLoad =
        changed.has("chatLoading") && changed.get("chatLoading") === true && !state.chatLoading;
      const previousStream = changed.get("chatStream") as string | null | undefined;
      const streamJustStarted =
        changed.has("chatStream") &&
        (previousStream === null || previousStream === undefined) &&
        typeof state.chatStream === "string";
      scheduleChatScroll(
        state as unknown as Parameters<typeof scheduleChatScroll>[0],
        forcedByLoad || streamJustStarted || !state.chatHasAutoScrolled,
      );
    },
  }),
});
