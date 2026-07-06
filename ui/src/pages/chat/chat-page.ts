import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../../components/command-palette.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  resolveSessionKey,
  searchForSession,
  scopedAgentParamsForSession,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { refreshChatAvatar } from "./chat-avatar.ts";
import { refreshSlashCommands } from "./chat-commands.ts";
import {
  applyChatAgentsList,
  clearChatHistory,
  loadChatHistory,
  syncSelectedSessionMessageSubscription,
} from "./chat-history.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue.ts";
import { dismissRealtimeTalkError } from "./chat-realtime.ts";
import { flushChatQueueForEvent, retryReconnectableQueuedChatSends } from "./chat-send.ts";
import {
  flushChatQueueAfterIdleSessionReconciliation,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import {
  canCreateChatSession,
  ChatStateController,
  createPageState,
  dismissChatError,
  handleChatManualRefresh,
  handlePageGatewayEvent,
  refreshChatCommands,
  refreshChatModelAuthStatus,
  refreshPageChat,
  refreshRouteSessionOptions,
  resetChatStateForRouteSession,
  resolveAssistantAttachmentAuthToken,
  resolveChatAgentId,
  resolveChatAvatarUrl,
  saveRouteSessionSettings,
  type ChatPageHost,
} from "./chat-state.ts";
import { renderChat, resetChatViewState, type ChatProps } from "./chat-view.ts";
import { renderChatControls } from "./components/chat-controls.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import {
  CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
  type DetailFullMessageResult,
  type SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
import { exportChatMarkdown } from "./export.ts";
import {
  hasAbortableSessionRun,
  reconcileStaleChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";

type ChatRouteData = {
  sessionKey: string;
  draft?: string;
};

type ChatPageContext = ApplicationContext;

const CHAT_OPEN_DETAILS_SELECTOR =
  ".chat-controls__inline-select[open], .context-usage details[open], .agent-chat__talk-select[open]";

const NEW_SESSION_ACTIVE_RUN_MESSAGE =
  "Start a new session after the active run or queued messages finish.";
const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
const NEW_SESSION_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new session. Try again in a moment.";

export class ChatPage extends LitElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ChatPageContext;
  @property({ attribute: false }) data!: ChatRouteData;

  private readonly chatState = new ChatStateController<ChatPageHost>(this);
  private state: ChatPageHost | undefined;
  private connectedClient: GatewayBrowserClient | null = null;
  private connectionGeneration = 0;

  private applyRouteSessionKey(sessionKey: string) {
    const state = this.state;
    if (!state) {
      return;
    }
    const nextSessionKey = resolveSessionKey(sessionKey, this.context.gateway.snapshot.hello);
    if (!nextSessionKey) {
      return;
    }
    state.sessionKey = nextSessionKey;
    saveRouteSessionSettings(state, nextSessionKey);
    this.context.gateway.setSessionKey(nextSessionKey);
    const agentId = parseAgentSessionKey(nextSessionKey)?.agentId;
    if (agentId) {
      this.context.agentSelection.set(agentId);
    }
  }

  private switchRouteSession(nextSessionKey: string) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousSessionKey = state.sessionKey;
    const previousSessionsResult = state.sessionsResult;
    const nextSessionRow = state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey);
    const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
    resetChatStateForRouteSession(state, nextSessionKey);
    this.context.gateway.setSessionKey(nextSessionKey);
    if (previousSessionKey !== nextSessionKey) {
      state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
    }
    void state.loadAssistantIdentity();
    void refreshChatAvatar(state);
    void refreshSlashCommands({
      client: state.client,
      agentId: parseAgentSessionKey(nextSessionKey)?.agentId,
    });
    const subscriptionSync = syncSelectedSessionMessageSubscription(state);
    const historyLoad = loadChatHistory(state);
    state.requestUpdate();
    const scheduleHistoryScroll = () => {
      if (state.sessionKey !== nextSessionKey) {
        return;
      }
      state.requestUpdate();
      scheduleChatScroll(state, true);
    };
    void historyLoad.then(scheduleHistoryScroll, scheduleHistoryScroll);
    void historyLoad.then(
      () => this.sendPendingSkillWorkshopRevision(nextSessionKey),
      () => this.sendPendingSkillWorkshopRevision(nextSessionKey),
    );
    const sessionsRefresh = refreshRouteSessionOptions(state);
    flushChatQueueAfterIdleSessionReconciliation(
      state,
      nextSessionKey,
      historyLoad,
      sessionsRefresh,
      previousSessionsResult,
      () => void flushChatQueueForEvent(state),
    );
    void subscriptionSync;
    void historyLoad;
    void sessionsRefresh;
  }

  private readonly handleCommandPaletteSlashCommand = (command: string) => {
    const state = this.state;
    if (!state) {
      return;
    }
    state.handleChatDraftChange(command.endsWith(" ") ? command : `${command} `);
    state.requestUpdate?.();
  };

  private announceCommandPaletteTarget(
    onSlashCommand: CommandPaletteTargetDetail["onSlashCommand"],
  ) {
    this.dispatchEvent(
      new CustomEvent<CommandPaletteTargetDetail>(COMMAND_PALETTE_TARGET_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          owner: this,
          onSlashCommand,
        },
      }),
    );
  }

  private readonly createSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected) {
      return false;
    }
    if (!canCreateChatSession(state)) {
      state.lastError = NEW_SESSION_ACTIVE_RUN_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }
    if (state.sessionsLoading) {
      state.lastError = NEW_SESSION_LIST_LOADING_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }

    state.lastError = null;
    state.chatError = null;
    const previousSessionKey = state.sessionKey;
    const nextSessionKey = await this.context.sessions.create({
      currentSessionKey: previousSessionKey,
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
    });
    if (
      !nextSessionKey ||
      state.sessionKey !== previousSessionKey ||
      !canCreateChatSession(state)
    ) {
      if (!nextSessionKey) {
        state.lastError =
          state.sessionsError ??
          (state.sessionsLoading
            ? NEW_SESSION_LIST_LOADING_MESSAGE
            : NEW_SESSION_CREATE_FAILED_MESSAGE);
        state.chatError = state.lastError;
        state.requestUpdate?.();
      }
      return false;
    }
    this.chatState.captureCreatedSessionComposer(nextSessionKey);
    this.context.navigate("chat", {
      search: searchForSession(nextSessionKey),
    });
    return true;
  };

  private sendPendingSkillWorkshopRevision(expectedSessionKey: string) {
    const state = this.state;
    if (!state || !state.connected || state.sessionKey !== expectedSessionKey) {
      return;
    }
    const revision = this.context.skillWorkshopRevision.consume(expectedSessionKey);
    if (!revision) {
      return;
    }
    void state
      .handleSendChat(revision.instructions, {
        restoreDraft: true,
        skillWorkshopRevision: {
          proposalId: revision.proposalId,
          agentId: revision.proposalAgentId,
        },
      })
      .catch((error: unknown) => {
        state.lastError = error instanceof Error ? error.message : String(error);
        state.chatError = state.lastError;
        state.requestUpdate?.();
      });
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape") {
      return;
    }
    const state = this.state;
    if (!state) {
      return;
    }
    const openDetails = this.querySelectorAll<HTMLDetailsElement>(CHAT_OPEN_DETAILS_SELECTOR);
    if (openDetails.length > 0) {
      event.preventDefault();
      openDetails.forEach((details) => {
        details.open = false;
      });
      return;
    }
    if (state.realtimeTalkOptionsOpen) {
      event.preventDefault();
      state.realtimeTalkOptionsOpen = false;
      state.requestUpdate();
      return;
    }
    if (!state.chatMobileControlsOpen) {
      return;
    }
    event.preventDefault();
    state.setChatMobileControlsOpen(false, { restoreFocus: true });
  };

  private readonly handleDocumentPointerdown = (event: PointerEvent) => {
    const state = this.state;
    if (!state) {
      return;
    }
    const path = event.composedPath();
    let changed = false;
    this.querySelectorAll<HTMLDetailsElement>(CHAT_OPEN_DETAILS_SELECTOR).forEach((details) => {
      if (!path.includes(details)) {
        details.open = false;
        changed = true;
      }
    });
    if (state.realtimeTalkOptionsOpen) {
      const insideTalkOptions = Array.from(
        this.querySelectorAll(
          ".agent-chat__talk-options, [aria-label='Talk settings'], [aria-label='Talk options']",
        ),
      ).some((node) => path.includes(node));
      if (!insideTalkOptions) {
        state.realtimeTalkOptionsOpen = false;
        changed = true;
      }
    }
    if (changed) {
      state.requestUpdate();
    }
    if (!state.chatMobileControlsOpen) {
      return;
    }
    const wrapper =
      this.querySelector(".chat-settings-popover-wrapper") ??
      this.querySelector(".chat-mobile-controls-wrapper");
    if (wrapper && path.includes(wrapper)) {
      return;
    }
    state.setChatMobileControlsOpen(false);
  };

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    document.addEventListener("pointerdown", this.handleDocumentPointerdown, true);
    const chatState = this.chatState;
    chatState.addCleanup(() => {
      document.removeEventListener("keydown", this.handleDocumentKeydown, true);
      document.removeEventListener("pointerdown", this.handleDocumentPointerdown, true);
    });
    const pageState = createPageState(this.context, chatState.requestUpdate, this);
    pageState.createChatSession = async () => {
      await this.createSession();
    };
    pageState.exportCurrentChat = () =>
      exportChatMarkdown(pageState.chatMessages, pageState.assistantName);
    pageState.refreshCurrentSessionTools = async () => {
      await pageState.onModelChanged?.();
      pageState.requestUpdate?.();
    };
    pageState.refreshCurrentChat = async () => {
      await refreshPageChat(pageState);
      pageState.requestUpdate?.();
    };
    this.state = pageState;
    chatState.attach(pageState);
    this.announceCommandPaletteTarget(this.handleCommandPaletteSlashCommand);
    if (this.data?.sessionKey) {
      this.applyRouteSessionKey(this.data.sessionKey);
    }
    chatState.restoreComposer({ preserveCurrent: true });
    if (this.data?.draft !== undefined) {
      this.state.handleChatDraftChange(this.data.draft);
    }
    chatState.addCleanup(
      this.context.nativeChatDrafts.subscribe((draft) => {
        const state = this.state;
        if (!state) {
          return;
        }
        state.handleChatDraftChange(draft);
        state.requestUpdate?.();
      }),
    );
    chatState.startComposerPersistence();
    chatState.addCleanup(
      this.context.gateway.subscribe((snapshot) => {
        this.applyGatewaySnapshot(snapshot);
      }),
    );
    chatState.addCleanup(
      this.context.gateway.subscribeEvents((event) => {
        const state = this.state;
        if (state) {
          handlePageGatewayEvent(state, event);
        }
      }),
    );
    this.applyApplicationConfig(this.context.config.current);
    chatState.addCleanup(
      this.context.config.subscribe((config) => {
        this.applyApplicationConfig(config);
      }),
    );
    this.applySessionsState(this.context.sessions.state);
    chatState.addCleanup(
      this.context.sessions.subscribe((state) => {
        this.applySessionsState(state);
      }),
    );
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override willUpdate(changedProperties: Map<PropertyKey, unknown>) {
    if (changedProperties.has("data") && this.state && this.data) {
      const nextSessionKey = resolveSessionKey(
        this.data.sessionKey,
        this.context.gateway.snapshot.hello,
      );
      if (nextSessionKey && nextSessionKey !== this.state.sessionKey) {
        this.switchRouteSession(nextSessionKey);
      } else if (nextSessionKey) {
        this.applyRouteSessionKey(nextSessionKey);
      }
      this.chatState.restoreCreatedSessionComposer(nextSessionKey);
      if (this.data.draft !== undefined && this.data.draft !== this.state.chatMessage) {
        this.state.handleChatDraftChange(this.data.draft);
      }
    }
  }

  override disconnectedCallback() {
    this.announceCommandPaletteTarget(null);
    resetChatViewState();
    this.state = undefined;
    this.connectedClient = null;
    super.disconnectedCallback();
  }

  private applySessionsState(stateValue: ApplicationContext["sessions"]["state"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const selectedSessionDeleted = stateValue.deletedSessions.some(({ key, agentId }) =>
      uiSessionEventMatches(
        {
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
          sessionKey: state.sessionKey,
        },
        key,
        agentId,
      ),
    );
    for (const { key } of stateValue.deletedSessions) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey: key });
    }
    state.sessionsResult = stateValue.result;
    state.sessionsResultAgentId = stateValue.agentId;
    state.sessionsLoading = stateValue.loading;
    state.sessionsError = stateValue.error;
    const selectedSession = stateValue.result?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, state.sessionKey),
    );
    if (selectedSession) {
      state.selectedChatSessionArchived = selectedSession.archived === true;
    }
    if (selectedSessionDeleted) {
      const agentId =
        parseAgentSessionKey(state.sessionKey)?.agentId ??
        this.context.agentSelection.state.selectedId ??
        "main";
      this.context.replace("chat", {
        search: searchForSession(
          buildAgentMainSessionKey({
            agentId,
            mainKey: resolveUiConfiguredMainKey({
              agentsList: this.context.agents.state.agentsList,
              hello: this.context.gateway.snapshot.hello,
            }),
          }),
        ),
      });
      return;
    }
    const reconciledLocalCompletion = reconcileStaleChatRunAfterSessionStatePublication(state);
    if (!reconciledLocalCompletion) {
      state.requestUpdate?.();
    }
  }

  private applyApplicationConfig(config: ApplicationContext["config"]["current"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const rootsChanged =
      state.localMediaPreviewRoots.length !== config.localMediaPreviewRoots.length ||
      state.localMediaPreviewRoots.some(
        (value, index) => value !== config.localMediaPreviewRoots[index],
      );
    if (
      !rootsChanged &&
      state.embedSandboxMode === config.embedSandboxMode &&
      state.allowExternalEmbedUrls === config.allowExternalEmbedUrls &&
      state.chatMessageMaxWidth === config.chatMessageMaxWidth
    ) {
      return;
    }
    state.localMediaPreviewRoots = config.localMediaPreviewRoots;
    state.embedSandboxMode = config.embedSandboxMode;
    state.allowExternalEmbedUrls = config.allowExternalEmbedUrls;
    state.chatMessageMaxWidth = config.chatMessageMaxWidth;
    state.requestUpdate?.();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const state = this.state;
    if (!state) {
      return;
    }
    const wasConnected = state.connected;
    const clientChanged = this.connectedClient !== snapshot.client;
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    state.hello = snapshot.hello;
    state.assistantAgentId = snapshot.assistantAgentId;
    const routeSessionKey = this.data?.sessionKey?.trim();
    const canonicalRouteSessionKey = routeSessionKey
      ? resolveSessionKey(routeSessionKey, snapshot.hello)
      : null;
    if (
      routeSessionKey &&
      canonicalRouteSessionKey &&
      canonicalRouteSessionKey !== routeSessionKey
    ) {
      this.context.replace("chat", {
        search: searchForSession(canonicalRouteSessionKey),
      });
      state.requestUpdate?.();
      return;
    }
    state.assistantName = this.context.config.current.assistantIdentity.name;
    if (!snapshot.connected) {
      if (wasConnected) {
        this.connectionGeneration += 1;
        const currentSessionId =
          typeof state.currentSessionId === "string" ? state.currentSessionId.trim() : "";
        if (currentSessionId) {
          state.reconnectResumeSessionId = currentSessionId;
        }
        markQueuedChatSendsWaitingForReconnect(state);
      }
      this.connectedClient = null;
      state.realtimeTalkSession?.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "idle";
      state.resetToolStream();
      state.requestUpdate?.();
      return;
    }
    if (clientChanged && snapshot.client) {
      const startupClient = snapshot.client;
      const startupGeneration = ++this.connectionGeneration;
      const startupSessionKey = state.sessionKey;
      const agentsListBeforeStartup = this.context.agents.state.agentsList;
      const clientIsCurrent = () =>
        this.connectionGeneration === startupGeneration &&
        this.connectedClient === startupClient &&
        state.client === startupClient &&
        state.connected;
      const finishStartup = async () => {
        if (!clientIsCurrent()) {
          return;
        }
        let agentsList = this.context.agents.state.agentsList;
        if (agentsList === agentsListBeforeStartup) {
          agentsList = await this.context.agents.ensureList();
        }
        if (!clientIsCurrent()) {
          return;
        }
        if (agentsList) {
          applyChatAgentsList(state, agentsList, startupClient);
        }
        state.requestUpdate?.();
        if (state.sessionKey === startupSessionKey) {
          this.sendPendingSkillWorkshopRevision(startupSessionKey);
        }
      };
      this.connectedClient = startupClient;
      void syncSelectedSessionMessageSubscription(state, { force: true });
      void retryReconnectableQueuedChatSends(state);
      void refreshPageChat(state, { startup: true, awaitHistory: true }).finally(() => {
        void finishStartup();
      });
      void refreshChatModelAuthStatus(state).finally(() => state.requestUpdate?.());
      void state.loadAssistantIdentity();
    }
    state.requestUpdate?.();
  }

  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const currentAgentId = resolveChatAgentId(state);
    const selectedSessionArchived =
      state.selectedChatSessionArchived ||
      state.sessionsResult?.sessions.some(
        (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, state.sessionKey),
      ) === true;
    const disabledReason = !state.connected
      ? t("chat.disconnected")
      : selectedSessionArchived
        ? t("chat.archivedSessionDisabled")
        : null;
    const canOpenRealtimeTalkSettings = hasOperatorAdminAccess(
      this.context.gateway.snapshot.hello?.auth ?? null,
    );
    const props: ChatProps = {
      sessionKey: state.sessionKey,
      onSessionKeyChange: (next) => {
        this.context.navigate("chat", {
          search: searchForSession(next),
        });
      },
      thinkingLevel: state.chatThinkingLevel,
      autoExpandToolCalls: state.chatVerboseLevel === "full",
      showThinking: state.settings.chatShowThinking,
      showToolCalls: state.settings.chatShowToolCalls,
      loading: state.chatLoading,
      sending: state.chatSending,
      canAbort: hasAbortableSessionRun(state),
      runStatus: state.chatRunStatus,
      compactionStatus: state.compactionStatus,
      fallbackStatus: state.fallbackStatus,
      messages: state.chatMessages,
      sideResult: state.chatSideResult,
      toolMessages: state.chatToolMessages,
      streamSegments: state.chatStreamSegments,
      stream: state.chatStream,
      streamStartedAt: state.chatStreamStartedAt,
      assistantAvatarUrl: resolveChatAvatarUrl(state),
      draft: state.chatMessage,
      queue: state.chatQueue,
      realtimeTalkActive: state.realtimeTalkActive,
      realtimeTalkStatus: state.realtimeTalkStatus,
      realtimeTalkDetail: state.realtimeTalkDetail,
      realtimeTalkTranscript: state.realtimeTalkTranscript,
      realtimeTalkConversation: state.realtimeTalkConversation,
      realtimeTalkOptionsOpen: state.realtimeTalkOptionsOpen,
      realtimeTalkOptions: state.realtimeTalkOptions,
      canOpenRealtimeTalkSettings,
      connected: state.connected,
      canSend: state.connected && !selectedSessionArchived,
      disabledReason,
      error: state.lastError,
      sessions: state.sessionsResult,
      composerControls: renderChatControls({
        agentsList: state.agentsList,
        connected: state.connected,
        hideCronSessions: state.sessionsHideCron,
        loading: state.chatLoading,
        manualRefreshInFlight: state.chatManualRefreshInFlight,
        model: {
          activeRunId: state.chatRunId,
          connected: state.connected,
          gatewayAvailable: Boolean(state.client),
          loading: state.chatLoading,
          modelCatalog: state.chatModelCatalog,
          modelOverrides: state.sessions.state.modelOverrides,
          modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
          modelsLoading: state.chatModelsLoading,
          sending: state.chatSending,
          sessionKey: state.sessionKey,
          sessionsResult: state.sessionsResult,
          stream: state.chatStream,
          onFastModeSelect: (next) => switchChatFastMode(state, next),
          onModelSelect: (next) => switchChatModel(state, next),
          onThinkingSelect: (next) => switchChatThinkingLevel(state, next),
        },
        onboarding: state.onboarding,
        quota: {
          basePath: state.basePath,
          modelAuthStatusResult: state.modelAuthStatusResult,
        },
        runId: state.chatRunId,
        sending: state.chatSending,
        settings: state.settings,
        settingsOpen: state.chatMobileControlsOpen,
        sessionKey: state.sessionKey,
        sessionsResult: state.sessionsResult,
        stream: state.chatStream,
        onRefresh: () => handleChatManualRefresh(state),
        onSettingsChange: state.applySettings,
        onSettingsOpenChange: state.setChatMobileControlsOpen,
        onToggleCronSessions: () => {
          state.sessionsHideCron = !state.sessionsHideCron;
          state.requestUpdate?.();
        },
      }),
      sessionWorkspace: createSessionWorkspaceProps(state),
      onRefresh: () => {
        state.chatSideResult = null;
        state.resetToolStream();
        void refreshPageChat(state, { awaitHistory: true, scheduleScroll: false });
      },
      onChatScroll: state.handleChatScroll,
      getDraft: () => state.chatMessage,
      onDraftChange: state.handleChatDraftChange,
      onRequestUpdate: state.requestUpdate,
      onHistoryKeydown: state.handleChatInputHistoryKey,
      onSlashIntent: () => refreshChatCommands(state),
      showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
      onScrollToBottom: state.scrollToBottom,
      attachments: state.chatAttachments,
      onAttachmentsChange: (next) => {
        state.chatAttachments = next;
        state.requestUpdate?.();
      },
      onSend: () => void state.handleSendChat(),
      onCompact: () => void state.handleSendChat("/compact"),
      onOpenSessionCheckpoints: () => {
        const search = new URLSearchParams({ session: state.sessionKey });
        if (selectedSessionArchived) {
          search.set("showArchived", "1");
        }
        this.context.navigate("sessions", { search: `?${search.toString()}` });
      },
      onToggleRealtimeTalk: () => void state.toggleRealtimeTalk(),
      onToggleRealtimeTalkOptions: () => {
        state.realtimeTalkOptionsOpen = !state.realtimeTalkOptionsOpen;
        state.requestUpdate?.();
      },
      onRealtimeTalkOptionsChange: state.updateRealtimeTalkOptions,
      onOpenRealtimeTalkSettings: () => {
        if (!canOpenRealtimeTalkSettings) {
          return;
        }
        state.realtimeTalkOptionsOpen = false;
        this.context.navigate("communications", { search: "?section=talk" });
      },
      onDismissError: () => {
        dismissChatError(state as never);
        state.requestUpdate?.();
      },
      onDismissRealtimeTalkError: () => {
        dismissRealtimeTalkError(state as never);
        state.requestUpdate?.();
      },
      onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
      onQueueRemove: state.removeQueuedMessage,
      onQueueRetry: (id) => void state.retryQueuedChatMessage(id),
      onQueueSteer: (id) => void state.steerQueuedChatMessage(id),
      onDismissSideResult: () => {
        state.chatSideResult = null;
        state.requestUpdate?.();
      },
      replyTarget: state.chatReplyTarget ?? null,
      onClearReply: () => {
        state.chatReplyTarget = null;
        state.requestUpdate?.();
      },
      onSetReply: (target) => {
        state.chatReplyTarget = target;
        state.requestUpdate?.();
      },
      onNewSession: () => void this.createSession(),
      onClearHistory: () => void clearChatHistory(state),
      agentsList: state.agentsList,
      currentAgentId,
      fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
      onAgentChange: (agentId) => {
        this.context.agentSelection.set(agentId);
        const nextSessionKey = buildAgentMainSessionKey({ agentId });
        this.context.navigate("chat", {
          search: searchForSession(nextSessionKey),
        });
      },
      onSessionSelect: (next) => {
        this.context.navigate("chat", {
          search: searchForSession(next),
        });
      },
      onLoadSidebarFullMessage: async (
        request: SidebarFullMessageRequest,
      ): Promise<DetailFullMessageResult | null> => {
        if (!state.client || !state.connected) {
          return null;
        }
        return state.client.request<DetailFullMessageResult>("chat.message.get", {
          sessionKey: request.sessionKey,
          ...(request.agentId ? { agentId: request.agentId } : {}),
          messageId: request.messageId,
          maxChars: CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
        });
      },
      sidebarOpen: state.sidebarOpen,
      sidebarContent: state.sidebarContent,
      splitRatio: state.splitRatio,
      canvasPluginSurfaceUrl: state.hello?.pluginSurfaceUrls?.canvas ?? null,
      onOpenSidebar: state.handleOpenSidebar,
      onCloseSidebar: state.handleCloseSidebar,
      onSplitRatioChange: state.handleSplitRatioChange,
      assistantName: state.assistantName,
      assistantAvatar: state.assistantAvatar,
      userName: state.userName,
      userAvatar: state.userAvatar,
      localMediaPreviewRoots: state.localMediaPreviewRoots,
      embedSandboxMode: state.embedSandboxMode,
      allowExternalEmbedUrls: state.allowExternalEmbedUrls,
      chatMessageMaxWidth: state.chatMessageMaxWidth,
      assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state as never),
      onAssistantAttachmentLoaded: () => state.scrollToBottom(),
      basePath: state.basePath,
    };
    return renderChat(props);
  }
}

if (!customElements.get("openclaw-chat-page")) {
  customElements.define("openclaw-chat-page", ChatPage);
}
