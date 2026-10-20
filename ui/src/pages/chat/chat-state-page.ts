import { getObserver } from "@solidjs/signals";
import {
  dispatchCommandClientPresentation,
  type CommandClientPresentationAction,
} from "../../app/command-client-presentation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayControlUiReloadOptions } from "../../app/gateway-control-ui-reload.ts";
import {
  autoPromptNotificationsOnSend,
  hasActiveNotificationPromptGesture,
  shouldAutoPromptNotificationsOnSend,
} from "../../app/notifications-auto-prompt.ts";
import { loadLocalUserIdentity, loadSettings, patchSettings } from "../../app/settings.ts";
import { retryStaleChunkReloadWhenReachable } from "../../app/stale-chunk-reload.ts";
import { hasSameOriginGatewayTransport } from "../../dev-gateway.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { hasUnrestrictedModelCatalogSnapshot } from "../../lib/model-catalog-cache.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import { canonicalUiSessionKeyForPersistence } from "../../lib/sessions/session-key.ts";
import { resolveSpeechTextLimit } from "../../lib/speech-playback.ts";
import { loadPageAssistantIdentity } from "./chat-assistant-identity.ts";
import { resolveAgentIdForSession } from "./chat-avatar.ts";
import { createChatErrorState } from "./chat-error-state.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { cancelPendingQueuedChatInput } from "./chat-history-actions.ts";
import {
  CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
  CHAT_HISTORY_RECOVERY_CHANGED_EVENT,
} from "./chat-history-events.ts";
import { chatHistoryRequests, setChatError } from "./chat-history-state.ts";
import { subscribeChatOutboxQueue } from "./chat-outbox-queue.ts";
import { chatSessionPresentationKey } from "./chat-pane-session-presentation.ts";
import { chatProviderReviewRow } from "./chat-provider-review.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { attachChatRealtimeActions, createInitialChatRealtimeState } from "./chat-realtime.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import {
  moveQueuedChatMessage,
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import { requestChatSend, resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { safeMediaAttachmentHref } from "./components/chat-attachment-href.ts";
import {
  openSessionWorkspacePreview,
  getSessionWorkspace,
  clearSessionWorkspacePreviews,
} from "./components/chat-session-workspace-state.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  resetChatInputHistoryNavigation,
} from "./input-history.ts";
import {
  activeQueuedMessageEdit,
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  isQueuedMessageBeingEdited,
  QUEUED_MESSAGE_EDIT_CONFLICT_ERROR,
  QUEUED_MESSAGE_REMOVAL_CONFLICT_ERROR,
  updateQueuedMessageEdit,
} from "./queued-message-edit.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import { handleAbortChat, hasAbortableSessionRun, isChatStopCommand } from "./run-lifecycle.ts";
import { handleChatScroll, resetChatScroll, scheduleChatScroll } from "./scroll.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import {
  updateSidebarSessionActivePanel,
  updateSidebarSessionLayout,
} from "./sidebar-layout-persistence.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  closeSlot,
  fitSidebarLayout,
  normalizeSidebarLayout,
  type SidebarLayout,
  openSlot,
  sidebarDashboardPresentation,
} from "./sidebar-layout.ts";
import type { RunOutputUsage } from "./tool-stream-contract.ts";
import { resetToolStream } from "./tool-stream-state.ts";

type ChatPageElement = {
  sessionKey?: string;
  dispatchEvent: (event: Event) => boolean;
  getBoundingClientRect?: () => DOMRect;
  transcriptLoadingChanged?: () => void;
};

export function invalidateImageLightbox(state: ChatPageHost) {
  state.imageLightboxRequestVersion += 1;
  const item = state.imageLightbox;
  state.imageLightbox = null;
  item?.release?.();
  return state.imageLightboxRequestVersion;
}

export function createPageState(
  context: ApplicationContext,
  renderLifecycle: Pick<RenderLifecycle, "afterCommit">,
  page: ChatPageElement,
  chatMessagesBySession: ChatMessageCache = new Map(),
): ChatPageHost {
  const settings = loadSettings();
  const initialSessionKey = page.sessionKey?.trim() || settings.sessionKey;
  const sidebarSessionKey = canonicalUiSessionKeyForPersistence(
    { agentsList: context.agents.state.agentsList, hello: context.gateway?.snapshot.hello },
    initialSessionKey,
  );
  const identity = loadLocalUserIdentity();
  const appConfig = context.config.current;
  const bootstrapIdentity =
    hasSameOriginGatewayTransport(context.gateway.connection.gatewayUrl) &&
    appConfig.assistantIdentity.agentId ===
      resolveAgentIdForSession({
        sessionKey: initialSessionKey,
        assistantAgentId: context.agentSelection.state.selectedId,
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      })
      ? appConfig.assistantIdentity
      : null;
  const errors = createChatErrorState();
  const presentedFields = {
    settings,
    // Unscoped names retain the gateway-wide fallback.
    assistantName:
      bootstrapIdentity?.name ??
      (appConfig.assistantIdentity.agentId ? "" : appConfig.assistantIdentity.name),
    assistantAvatar: bootstrapIdentity?.avatar ?? null,
    assistantAvatarStatus: bootstrapIdentity?.avatarStatus ?? null,
    assistantAvatarReason: bootstrapIdentity?.avatarReason ?? null,
    embedSandboxMode: appConfig.embedSandboxMode,
    allowExternalEmbedUrls: appConfig.allowExternalEmbedUrls,
    automaticallyFetchFavicons: appConfig.automaticallyFetchFavicons,
    client: null,
    connected: false,
    connectionEpoch: 0,
    mediaPolicyEpoch: 0,
    hello: null,
    selfUser: null,
    canvasPluginSurfaceUrl: null,
    terminalAvailable: false,
    browserPanelAvailable: false,
    assistantAgentId: context.agentSelection.state.selectedId,
    sessionKey: initialSessionKey,
    currentSessionId: undefined,
    chatLoading: false,
    chatHistoryPagination: { hasMore: false },
    chatSending: false,
    chatDisplayedLeafEntryId: undefined as string | null | undefined,
    chatBranches: [],
    chatBranchesSessionKey: null,
    chatBranchesConnectionEpoch: null,
    chatReplyTarget: null,
    senderAgentAvatars: undefined,
    chatAvatarUrl: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatModelSwitchPromises: {},
    chatModelPickerOpenSessionKey: null,
    chatModelsLoading: false,
    chatModelCatalog: [],
    chatModelCatalogInitialized: hasUnrestrictedModelCatalogSnapshot(
      context.gateway.snapshot.client,
    ),
    chatModelSelectionPolicy: undefined,
    chatModelCatalogRetired: false,
    chatModelCatalogError: null,
    chatModelCatalogRefreshFailed: undefined,
    chatModelCatalogPendingProviders: undefined,
    chatAccountSelection: null,
    modelAuthStatusResult: null,
    sessionsLoading: false,
    sessionsError: null,
    selectedChatSessionArchived: false,
    selectedChatSessionIncognito: false,
    agentsList: context.agents.state.agentsList,
    pendingAbort: null,
    chatGoalDraftMode: null,
    chatSessionApprovalQueue: [],
    chatNewMessagesBelow: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatReadingHistory: false,
    sidebarLayout: normalizeSidebarLayout(settings.sidebarSessionLayouts?.[sidebarSessionKey]),
    sidebarContent: null,
    imageLightbox: null,
  } satisfies Partial<ChatPageHost>;
  const state = Object.assign(errors, presentedFields, {
    uploadConfig: context.config,
    captureComposerRecoveryReload: () => {
      const options = createGatewayControlUiReloadOptions(context.gateway);
      return () => retryStaleChunkReloadWhenReachable({ timeoutMs: 0, ...options });
    },
    sessions: context.sessions,
    hasPendingInitialTurn: (sessionKey: string) =>
      context.placementStartup.hasPendingTurn(sessionKey),
    chatSubmissions: context.chatSubmissions,
    assistantIdentityRequestVersion: 0,
    userName: identity.name,
    userAvatar: identity.avatar,
    chatMessage: "",
    chatMessages: [],
    chatToolMessages: [],
    guardianNotices: [],
    providerPolicyNotice: null,
    chatVerboseLevel: null,
    chatQueueModeOverride: undefined,
    chatEffectiveQueueMode: undefined,
    chatAttachments: [],
    chatRunId: null,
    chatRunUsageById: new Map<string, RunOutputUsage>(),
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunStartup: null,
    chatRunError: null,
    agentsError: null,
    chatStreamSegments: [],
    chatReasoning: null,
    chatRunStatus: null,
    compactionStatus: null,
    fallbackStatus: null,
    observerDigest: null,
    knownAgentRunIds: new Set(),
    waitingApprovalStatuses: new Map(),
    waitingApprovalResolvedIds: new Set(),
    modelAuthStatusRequestVersion: 0,
    sessionsResult: null,
    sessionsResultAgentId: null,
    sessionsArchivedFilter: "active",
    agentsSelectedId: context.agentSelection.state.selectedId,
    refreshSessionsAfterChat: new Map<string, { sessionKey: string; agentId?: string }>(),
    pendingSessionMessageReloadSessionKey: null,
    chatSubmitGuards: new Set<string>(),
    chatQueue: [],
    chatComposerFallbackByScope: {},
    chatSendingScopeKey: null,
    chatMessagesBySession,
    dispatchClientPresentation: (action: CommandClientPresentationAction) =>
      dispatchCommandClientPresentation(context, action),
    basePath: context.basePath,
    resourceBasePath: context.resourceBasePath,
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    chatStreamRenderFrame: null,
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    imageLightboxRequestVersion: 0,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    activityEventSeqById: new Map(),
    toolStreamSyncTimer: null,
    ...createInitialChatRealtimeState(),
    renderLifecycle,
    // Background warming gates on these edges. Session-event reloads never
    // re-render the page, so no update can carry the fact to it.
    transcriptLoadingChanged: () => {
      page.transcriptLoadingChanged?.();
      page.dispatchEvent(
        new CustomEvent(CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT, { bubbles: true, composed: true }),
      );
    },
    historyRecoveryChanged: () =>
      page.dispatchEvent(
        new Event(CHAT_HISTORY_RECOVERY_CHANGED_EVENT, { bubbles: true, composed: true }),
      ),
    sessionWorkspaceState: undefined,
  }) as unknown as ChatPageHost;

  state.resetToolStream = () => resetToolStream(state);
  state.resetChatInputHistoryNavigation = () => resetChatInputHistoryNavigation(state);
  state.scrollToBottom = (options) => {
    resetChatScroll(state);
    scheduleChatScroll(state, true, Boolean(options?.smooth), { source: "manual" });
  };
  state.handleChatScroll = (event) => handleChatScroll(state, event);
  state.handleChatDraftChange = (next, mentions) => handleChatDraftChange(state, next, mentions);
  state.handleChatInputHistoryKey = (input) => handleChatInputHistoryKey(state, input);
  state.applySettings = (patch) => {
    const next = { ...state.settings, ...patch };
    state.settings = patchSettings({
      chatShowThinking: next.chatShowThinking,
      chatShowToolCalls: next.chatShowToolCalls,
      chatPersistCommentary: next.chatPersistCommentary,
      chatSendShortcut: next.chatSendShortcut,
      chatBubbleSessionKeys: next.chatBubbleSessionKeys,
      chatBubbleDisabledSessionKeys: next.chatBubbleDisabledSessionKeys,
    });
  };
  attachChatRealtimeActions(
    state,
    () => !chatProviderReviewRow(state)?.providerReview,
    (message, runId) =>
      requestChatSend(state, {
        message,
        runId,
        expectedLeafEntryId: resolveDisplayedLeafEntryId(state),
      }),
    async () => {
      await context.runtimeConfig.ensureLoaded();
      return resolveSpeechTextLimit(
        context.runtimeConfig.state.configSnapshot?.runtimeConfig ??
          context.runtimeConfig.state.configSnapshot?.config,
      );
    },
  );
  state.loadAssistantIdentity = () => loadPageAssistantIdentity(state);
  state.handleSendChat = (messageOverride, options, submissionAction) => {
    const message = messageOverride ?? state.chatMessage;
    const isCommand =
      parseSlashCommand(message) !== null ||
      (isChatStopCommand(message) && hasAbortableSessionRun(state));
    if (
      shouldAutoPromptNotificationsOnSend({
        connected: state.connected,
        directComposerSend:
          messageOverride === undefined &&
          options === undefined &&
          hasActiveNotificationPromptGesture(),
        message,
        hasAttachments: state.chatAttachments.length > 0,
        isCommand,
      })
    ) {
      autoPromptNotificationsOnSend(context);
    }
    return handleSendChat(state, messageOverride, options, submissionAction);
  };
  state.handleAbortChat = (options) => handleAbortChat(state, options);
  state.removeQueuedMessage = (id) => {
    if (cancelPendingQueuedChatInput(state, id)) {
      return;
    }
    if (isQueuedMessageBeingEdited(state, id)) {
      setChatError(state, QUEUED_MESSAGE_REMOVAL_CONFLICT_ERROR);
      return;
    }
    const outcome = removeQueuedMessage(state, id, { discard: true });
    if (outcome === "removed") {
      setChatError(state, null);
      void resumeStoredChatOutboxes(state);
    } else if (outcome === "rejected") {
      setChatError(state, OFFLINE_QUEUE_STORAGE_ERROR);
    }
  };
  state.retryQueuedChatMessage = (id) => retryQueuedChatMessage(state, id);
  state.steerQueuedChatMessage = (id) => steerQueuedChatMessage(state, id);
  state.moveQueuedChatMessage = (id, targetId) => {
    moveQueuedChatMessage(state, id, targetId);
  };
  state.editQueuedChatMessage = (id) => {
    if (beginQueuedMessageEdit(state, id) === "unavailable") {
      setChatError(state, QUEUED_MESSAGE_EDIT_CONFLICT_ERROR);
    } else {
      for (const key of ["lastError", "chatError"] as const) {
        if (state[key] === QUEUED_MESSAGE_EDIT_CONFLICT_ERROR) {
          state[key] = null;
        }
      }
    }
  };
  state.updateQueuedChatMessageEdit = (draftText, mentions) => {
    updateQueuedMessageEdit(state, draftText, mentions);
  };
  state.submitQueuedChatMessageEdit = () => {
    const edit = activeQueuedMessageEdit(state);
    if (!edit) {
      return;
    }
    void state
      .handleSendChat(edit.draftText, {
        attachmentsOverride: [...edit.attachments],
        mentionsOverride: edit.mentions,
        resumeQueuedMessageEditId: edit.id,
      })
      .catch(() => undefined);
  };
  state.cancelQueuedChatMessageEdit = () => {
    if (cancelQueuedMessageEdit(state)) {
      // Reconnect may have parked the drain on this local hold; Cancel does not write storage.
      void resumeStoredChatOutboxes(state);
    }
  };
  const transientResources = new Set<"desktop">();
  let transientResourceScope = "";
  state.updateSidebarLayout = (layout, options) => {
    const layoutKey = canonicalUiSessionKeyForPersistence(state, state.sessionKey);
    const scope = JSON.stringify([state.settings.gatewayUrl, layoutKey]);
    if (scope !== transientResourceScope) {
      transientResources.clear();
      transientResourceScope = scope;
    }
    const normalized = normalizeSidebarLayout(layout);
    const previous = state.sidebarLayout;
    const includesResource = (value: SidebarLayout, slot: "desktop" | "browser") =>
      value.columns.some((column) => column.panels.some((panel) => panel.slot === slot));
    if (
      options?.automaticResource &&
      !includesResource(previous, options.automaticResource) &&
      includesResource(normalized, options.automaticResource)
    ) {
      transientResources.add(options.automaticResource);
    }
    for (const resource of transientResources) {
      const panel = normalized.columns
        .flatMap((column) => column.panels)
        .find((entry) => entry.slot === resource);
      // Explicit targets are saved choices, even when discovery first opened the tab.
      if (!panel || panel.environmentId !== undefined) {
        transientResources.delete(resource);
      }
    }
    if (
      previous.resourceAutoOpenDismissed ||
      (options?.persist !== false &&
        ((previous.open && !normalized.open) ||
          (includesResource(previous, "desktop") && !includesResource(normalized, "desktop")) ||
          (includesResource(previous, "browser") && !includesResource(normalized, "browser"))))
    ) {
      normalized.resourceAutoOpenDismissed = true;
    }
    const presentation =
      options?.dashboardPresentation === "personal"
        ? sidebarDashboardPresentation(normalized)
        : undefined;
    if (presentation) {
      const row = selectedChatSessionRow(state);
      // Unknown metadata cannot establish that the user chose the shared default.
      normalized.dashboardPresentationOverride =
        row && presentation === (row.boardPresentation ?? "split") ? null : presentation;
    }
    // Every close route commits here; tab switches retain the pending selection.
    if (
      (state.sidebarContent?.kind === "loading" || state.sidebarContent?.kind === "unavailable") &&
      !normalized.columns.some((column) => column.panels.some((panel) => panel.slot === "detail"))
    ) {
      state.sidebarContent = null;
    }
    state.sidebarLayout = normalized;
    if (options?.persist === false) {
      return;
    }
    // Other layout edits cannot persist an automatically discovered target before
    // ownership is checked again on reload. Dashboard restoration has its own policy.
    let persisted = normalized;
    for (const resource of transientResources) {
      persisted = closeSlot(persisted, resource);
    }
    state.settings = patchSettings({
      sidebarSessionLayouts: updateSidebarSessionLayout(
        loadSettings().sidebarSessionLayouts,
        layoutKey,
        persisted,
        {
          geometryOnly: options?.geometryOnly,
          dashboardPresentationOverride: presentation
            ? normalized.dashboardPresentationOverride
            : undefined,
        },
      ),
    });
    normalized.dashboardPresentationOverride =
      state.settings.sidebarSessionLayouts?.[layoutKey]?.dashboardPresentationOverride;
  };
  state.updateSidebarActivePanel = (panelId) => {
    const normalizedPanelId = panelId.trim();
    if (!normalizedPanelId) {
      return;
    }
    const selected = state.sidebarLayout.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.id === normalizedPanelId)?.slot;
    if (selected === "desktop" && transientResources.has(selected)) {
      return;
    }
    state.settings = patchSettings({
      sidebarSessionActivePanels: updateSidebarSessionActivePanel(
        loadSettings().sidebarSessionActivePanels,
        canonicalUiSessionKeyForPersistence(state, state.sessionKey),
        normalizedPanelId,
      ),
    });
  };
  state.handleOpenSidebar = (content) => {
    const fileTab =
      content?.fileTab ??
      (content?.kind === "attachment"
        ? {
            id: `attachment:${content.sourceIdentity ?? content.src ?? crypto.randomUUID()}`,
            label: content.title,
          }
        : content?.kind === "file"
          ? { id: `file:${content.path}`, label: content.name }
          : null);
    const targetSlot = fileTab ? "workspace" : "detail";
    let opened = openSlot(state.sidebarLayout, targetSlot);
    const targetPanel = opened.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === targetSlot);
    if (targetPanel) {
      opened = activatePanel(opened, targetPanel.id);
    }
    const availableWidth = page.getBoundingClientRect?.().width ?? 0;
    const fitted =
      availableWidth > 0 && availableWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(opened, availableWidth) ?? opened)
        : opened;
    if (fileTab && content) {
      const preview = openSessionWorkspacePreview(state, fileTab.id, fileTab.label, content);
      if (content.kind === "mcp-app" && preview.content.kind === "mcp-app") {
        // A second app link changes host context on the retained instance.
        preview.content = content;
        preview.label = fileTab.label;
        const workspace = getSessionWorkspace(state);
        workspace.previews = [...workspace.previews];
      }
    } else {
      state.sidebarContent = content;
    }
    state.updateSidebarLayout(fitted);
    if (targetPanel) {
      state.updateSidebarActivePanel(targetPanel.id);
    }
  };
  state.handleCloseSidebar = (slot) => {
    if (slot === "workspace") {
      clearSessionWorkspacePreviews(state);
    }
    state.updateSidebarLayout(closeSlot(state.sidebarLayout, slot));
  };
  state.beginImageOpen = () => invalidateImageLightbox(state);
  state.handleOpenImage = (item, requestVersion) => {
    const activeRequestVersion = requestVersion ?? state.beginImageOpen();
    if (activeRequestVersion !== state.imageLightboxRequestVersion) {
      item.release?.();
      return;
    }
    const resolveSrc = (src: string) =>
      item.kind === "video"
        ? safeMediaAttachmentHref(src, "video")
        : resolveSafeExternalUrl(src, window.location.href, { allowDataImage: true });
    const safeSrc = resolveSrc(item.src);
    const safeOriginalSrc = item.originalSrc ? resolveSrc(item.originalSrc) : undefined;
    if (!safeSrc || (item.originalSrc && !safeOriginalSrc)) {
      item.release?.();
      return;
    }
    state.imageLightbox = {
      ...item,
      src: safeSrc,
      ...(safeOriginalSrc ? { originalSrc: safeOriginalSrc } : {}),
    };
  };
  state.handleCloseImage = () => {
    invalidateImageLightbox(state);
  };
  projectChatFields(chatHistoryRequests(state), ["historyLoad", "acceptedHistory"]);
  {
    let value = state.chatQueue;
    const queue = projectSource(state, {
      read: () => value,
      subscribe: subscribeChatOutboxQueue,
      equality: "revision",
    });
    Object.defineProperty(state, "chatQueue", {
      configurable: true,
      enumerable: true,
      get: () => (getObserver() ? queue.read() : value),
      set: (next: typeof value) => {
        value = next;
      },
    });
  }
  {
    const source = chatRunPresentation(state);
    const projection = projectOwner(source, (owner) => owner.values);
    for (const key of source.fields) {
      const descriptor = Object.getOwnPropertyDescriptor(state, key)!;
      Object.defineProperty(state, key, {
        ...descriptor,
        get() {
          if (getObserver()) {
            projection.read();
          }
          return Reflect.get(source.values, key);
        },
      });
    }
  }
  {
    const errorProjection = projectSource(state, {
      read: (owner) => owner.readErrors(),
      subscribe: (owner, notify) => owner.subscribeErrors(notify),
      equality: (previous, next) =>
        previous.lastError === next.lastError && previous.chatError === next.chatError,
    });
    for (const key of ["lastError", "chatError"] as const) {
      Object.defineProperty(state, key, {
        ...Object.getOwnPropertyDescriptor(state, key),
        get: () => (getObserver() ? errorProjection.read()[key] : state.readErrors()[key]),
      });
    }
  }
  {
    let onChange: (() => void) | undefined;
    const presentation = projectSource(state, {
      read: (owner) =>
        chatSessionPresentationKey(
          owner,
          context.sessions.state,
          selectedChatSessionRow(owner),
          context.overlays?.snapshot?.approvalQueue,
        ),
      subscribe: (_owner, notify) => {
        onChange = notify;
        const stop = context.sessions.subscribe(notify);
        return () => {
          onChange = undefined;
          stop();
        };
      },
      equality: Object.is,
    });
    for (const key of ["sessionsResult", "sessionsResultAgentId"] as const) {
      let value = state[key];
      Object.defineProperty(state, key, {
        configurable: true,
        enumerable: true,
        get() {
          if (getObserver()) {
            presentation.revision();
          }
          return value;
        },
        set(next: typeof value) {
          if (Object.is(value, next)) {
            return;
          }
          value = next;
          onChange?.();
        },
      });
    }
  }
  return projectChatFields(
    state,
    // SAFETY: This literal owns every enumerable key passed to the projection.
    Object.keys(presentedFields) as (keyof typeof presentedFields)[],
  );
}
