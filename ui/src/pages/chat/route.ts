import { guard } from "lit/directives/guard.js";
import type { RouteRenderContext } from "../../app-routes.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { i18n } from "../../i18n/index.ts";
import { definePage } from "../../router/index.ts";
import {
  createChatSession,
  dismissChatError,
  dismissRealtimeTalkError,
  renderChatControls,
  resolveAssistantAttachmentAuthToken,
  switchChatSession,
} from "../../ui/app-render.helpers.ts";
import { scheduleChatScroll } from "../../ui/app-scroll.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../ui/session-key.ts";
import { loadLocalAssistantIdentity } from "../../ui/storage.ts";
import { isRenderableControlUiAvatarUrl } from "../../ui/views/agents-utils.ts";
import { loadChatPage } from "../loaders.ts";
import { loadSessions } from "../sessions/data.ts";
import {
  clearChatHistory,
  createChatSessionsLoadOverrides,
  hasAbortableSessionRun,
  refreshChat,
  refreshChatCommands,
  scopedAgentParamsForSession,
  scopedAgentListParamsForSession,
} from "./data.ts";
import { createSessionWorkspaceProps } from "./session-workspace.ts";
import { renderChat, resetChatViewState } from "./view.ts";

type ChatLoadContext = { host: SettingsHost; app: SettingsAppHost };
type ChatRenderContext = RouteRenderContext;

function resolveChatAgentId(state: AppViewState): string {
  return normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ??
      scopedAgentParamsForSession(state, state.sessionKey).agentId ??
      resolveUiSelectedGlobalAgentId(state),
  );
}

function resolveChatAvatarUrl(state: AppViewState): string | null {
  const agentId = resolveChatAgentId(state);
  const localAvatar = loadLocalAssistantIdentity({ agentId }).avatar;
  if (localAvatar) {
    return localAvatar;
  }
  const avatarMissing =
    (state.chatAvatarStatus ?? state.assistantAvatarStatus) === "none" &&
    (state.chatAvatarReason ?? state.assistantAvatarReason) === "missing";
  if (!avatarMissing && isRenderableControlUiAvatarUrl(state.assistantAvatar)) {
    if (state.assistantAgentId === agentId) {
      return state.assistantAvatar;
    }
  }
  if (state.chatAvatarUrl) {
    return state.chatAvatarUrl;
  }
  const identity = state.agentsList?.agents?.find((agent) => agent.id === agentId)?.identity;
  const avatar = identity?.avatarUrl ?? identity?.avatar;
  return typeof avatar === "string" && isRenderableControlUiAvatarUrl(avatar) ? avatar : null;
}

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
  loader: async ({ host, app }: ChatLoadContext) => {
    await loadChatPage(host, app);
  },
  onEnter: ({ host }: ChatLoadContext, _data, options) => {
    if (!options.revalidating) {
      host.chatHasAutoScrolled = false;
    }
  },
  onLeave: () => {
    resetChatViewState();
  },
  component: () => ({
    shell: "chat" as const,
    header: true,
    render: ({ state, navigate }: ChatRenderContext) =>
      renderChat({
        sessionKey: state.sessionKey,
        onSessionKeyChange: (next) => switchChatSession(state, next),
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
        canSend: state.connected,
        disabledReason: state.connected ? null : "Disconnected",
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
        onOpenSessionCheckpoints: () => {
          state.sessionsExpandedCheckpointKey = state.sessionKey;
          navigate("sessions");
          void loadSessions(state, {
            ...createChatSessionsLoadOverrides(state),
            ...scopedAgentListParamsForSession(state, state.sessionKey),
          });
        },
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
        onNewSession: () => void createChatSession(state, { source: "user" }),
        onClearHistory: () => void clearChatHistory(state),
        agentsList: state.agentsList,
        currentAgentId: resolveChatAgentId(state),
        fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
        onAgentChange: (agentId) => switchChatSession(state, buildAgentMainSessionKey({ agentId })),
        onNavigateToAgent: () => {
          state.agentsSelectedId = state.assistantAgentId;
          navigate("agents");
        },
        onSessionSelect: (key) => switchChatSession(state, key),
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
      }),
    onStateChange: ({ state }: ChatRenderContext, changed) => {
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
