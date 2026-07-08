import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
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
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveSessionKey, scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { SessionUnreadPatchGuard } from "../../lib/sessions/unread.ts";
import { refreshChatAvatar } from "./chat-avatar.ts";
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
  refreshChatMetadata,
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
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  revealSessionWorkspaceFile,
} from "./components/chat-session-workspace.ts";
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

type ChatPageContext = ApplicationContext;
type PaneSessionChangeOptions = { replace?: boolean };

const CHAT_OPEN_DETAILS_SELECTOR =
  ".chat-controls__inline-select[open], .context-usage details[open], .agent-chat__talk-select[open], .agent-chat__attach-menu[open]";

const NEW_SESSION_ACTIVE_RUN_MESSAGE =
  "Start a new session after the active run or queued messages finish.";
const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
const NEW_SESSION_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new session. Try again in a moment.";

class ChatPane extends LitElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ChatPageContext;
  @property({ attribute: false }) paneId = "single";
  // Empty means "no route/layout opinion yet": the pane boots on the page
  // state's default session and must not canonicalize or write global session
  // bindings until the container supplies a real key (classic mode renders
  // before route data resolves).
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) active = false;
  @property({ attribute: false }) chrome: "none" | "pane" = "none";
  @property({ attribute: false }) draft?: string;
  @property({ attribute: false }) onFocusPane?: (paneId: string) => void;
  @property({ attribute: false }) onPaneSessionChange?: (
    paneId: string,
    nextSessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => void;
  @property({ attribute: false }) onSplitRight?: (paneId: string) => void;
  @property({ attribute: false }) onSplitDown?: (paneId: string) => void;
  @property({ attribute: false }) onClosePane?: (paneId: string) => void;
  @property({ attribute: false }) onOpenSplitView?: () => void;

  private readonly chatState = new ChatStateController<ChatPageHost>(this);
  private state: ChatPageHost | undefined;
  private connectedClient: GatewayBrowserClient | null = null;
  private connectionGeneration = 0;
  private nativeDraftCleanup: (() => void) | null = null;
  private readonly unreadPatchGuard = new SessionUnreadPatchGuard();

  private markSessionRead(row: GatewaySessionRow | undefined) {
    const state = this.state;
    if (
      !state?.connected ||
      !row ||
      !this.unreadPatchGuard.shouldPatch(state.sessionKey, row.unread)
    ) {
      return;
    }
    const agentId = parseAgentSessionKey(row.key)?.agentId ?? resolveChatAgentId(state);
    const guardKey = state.sessionKey;
    void this.context.sessions.patch(row.key, { unread: false }, { agentId }).catch(() => {
      // Unlatch so later unread snapshots retry; the session capability
      // publishes the actionable error for the owning page.
      this.unreadPatchGuard.patchFailed(guardKey);
    });
  }

  private setPaneSessionKey(sessionKey: string): string | null {
    const state = this.state;
    if (!state) {
      return null;
    }
    const nextSessionKey = resolveSessionKey(sessionKey, this.context.gateway.snapshot.hello);
    if (!nextSessionKey) {
      return null;
    }
    state.sessionKey = nextSessionKey;
    return nextSessionKey;
  }

  // Global chrome (persisted session settings, gateway session, agent
  // selection) is owned by exactly one pane; the container guarantees a single
  // active pane, so inactive split panes must never run these bindings.
  private applyActiveSessionBindings() {
    const state = this.state;
    if (!state || !this.active || !this.sessionKey.trim()) {
      return;
    }
    const nextSessionKey = state.sessionKey;
    saveRouteSessionSettings(state, nextSessionKey);
    this.context.gateway.setSessionKey(nextSessionKey);
    const agentId = parseAgentSessionKey(nextSessionKey)?.agentId;
    if (agentId) {
      this.context.agentSelection.set(agentId);
    }
  }

  private switchPaneSession(nextSessionKey: string) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousSessionKey = state.sessionKey;
    const previousSessionsResult = state.sessionsResult;
    const nextSessionRow = state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey);
    const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
    resetChatStateForRouteSession(state, nextSessionKey);
    this.markSessionRead(nextSessionRow);
    if (previousSessionKey !== nextSessionKey) {
      state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
    }
    void state.loadAssistantIdentity();
    void refreshChatAvatar(state);
    void refreshChatMetadata(state).finally(() => state.requestUpdate?.());
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
    this.onPaneSessionChange?.(this.paneId, nextSessionKey);
    return true;
  };

  private syncActiveBindings() {
    this.nativeDraftCleanup?.();
    this.nativeDraftCleanup = null;
    if (!this.active) {
      this.announceCommandPaletteTarget(null);
      return;
    }
    this.announceCommandPaletteTarget(this.handleCommandPaletteSlashCommand);
    this.applyActiveSessionBindings();
    this.nativeDraftCleanup = this.context.nativeChatDrafts.subscribe((draft) => {
      const state = this.state;
      if (!state || !this.active) {
        return;
      }
      state.handleChatDraftChange(draft);
      state.requestUpdate?.();
    });
    this.sendPendingSkillWorkshopRevision(this.sessionKey);
  }

  private readonly handlePaneFocus = () => {
    this.onFocusPane?.(this.paneId);
  };

  private sendPendingSkillWorkshopRevision(expectedSessionKey: string) {
    const state = this.state;
    if (!this.active || !state || !state.connected || state.sessionKey !== expectedSessionKey) {
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
    this.addEventListener("pointerdown", this.handlePaneFocus);
    this.addEventListener("focusin", this.handlePaneFocus);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    document.addEventListener("pointerdown", this.handleDocumentPointerdown, true);
    const chatState = this.chatState;
    chatState.addCleanup(() => {
      document.removeEventListener("keydown", this.handleDocumentKeydown, true);
      document.removeEventListener("pointerdown", this.handleDocumentPointerdown, true);
      this.removeEventListener("pointerdown", this.handlePaneFocus);
      this.removeEventListener("focusin", this.handlePaneFocus);
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
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (mediaDevices?.addEventListener) {
      const handleDeviceChange = () => void pageState.refreshRealtimeTalkInputs();
      mediaDevices.addEventListener("devicechange", handleDeviceChange);
      chatState.addCleanup(() =>
        mediaDevices.removeEventListener("devicechange", handleDeviceChange),
      );
    }
    if (this.sessionKey) {
      this.setPaneSessionKey(this.sessionKey);
    }
    chatState.restoreComposer({ preserveCurrent: true });
    if (this.draft !== undefined) {
      this.state.handleChatDraftChange(this.draft);
    }
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
    if (changedProperties.has("sessionKey") && this.state) {
      const nextSessionKey = resolveSessionKey(
        this.sessionKey,
        this.context.gateway.snapshot.hello,
      );
      if (nextSessionKey && nextSessionKey !== this.state.sessionKey) {
        this.switchPaneSession(nextSessionKey);
      }
      this.chatState.restoreCreatedSessionComposer(nextSessionKey);
    }
    if (changedProperties.has("active") || changedProperties.has("sessionKey")) {
      this.syncActiveBindings();
    }
    if (
      changedProperties.has("draft") &&
      this.draft !== undefined &&
      this.state &&
      this.draft !== this.state.chatMessage
    ) {
      this.state.handleChatDraftChange(this.draft);
    }
  }

  override updated() {
    // The header <select> options arrive after the sessions list loads; a
    // .value template binding committed before the options exist leaves the
    // browser on the first option, so re-sync after every render.
    const select = this.querySelector<HTMLSelectElement>(".chat-pane__session-select");
    if (select && this.state && select.value !== this.state.sessionKey) {
      select.value = this.state.sessionKey;
    }
  }

  override disconnectedCallback() {
    this.nativeDraftCleanup?.();
    this.nativeDraftCleanup = null;
    this.announceCommandPaletteTarget(null);
    resetChatViewState(this.paneId);
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
      this.markSessionRead(selectedSession);
    }
    if (selectedSessionDeleted) {
      const agentId =
        parseAgentSessionKey(state.sessionKey)?.agentId ??
        this.context.agentSelection.state.selectedId ??
        "main";
      this.onPaneSessionChange?.(
        this.paneId,
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: this.context.agents.state.agentsList,
            hello: this.context.gateway.snapshot.hello,
          }),
        }),
      );
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
    const routeSessionKey = this.sessionKey.trim();
    const canonicalRouteSessionKey = routeSessionKey
      ? resolveSessionKey(routeSessionKey, snapshot.hello)
      : null;
    if (
      routeSessionKey &&
      canonicalRouteSessionKey &&
      canonicalRouteSessionKey !== routeSessionKey
    ) {
      this.onPaneSessionChange?.(this.paneId, canonicalRouteSessionKey, { replace: true });
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

  private renderPaneHeader(state: ChatPageHost) {
    if (this.chrome !== "pane") {
      return null;
    }
    const sessions = state.sessionsResult?.sessions ?? [];
    const currentSession = sessions.find((row) => row.key === state.sessionKey);
    const options = currentSession ? sessions : [{ key: state.sessionKey }, ...sessions];
    return html`
      <div class="chat-pane__header ${this.active ? "chat-pane--active" : ""}">
        <label class="chat-pane__session-label">
          <span class="agent-chat__sr-only">${t("chat.splitView.sessionSelect")}</span>
          <select
            class="chat-pane__session-select"
            aria-label=${t("chat.splitView.sessionSelect")}
            .value=${state.sessionKey}
            @change=${(event: Event) => {
              const nextSessionKey = (event.target as HTMLSelectElement).value;
              if (nextSessionKey && nextSessionKey !== state.sessionKey) {
                this.onPaneSessionChange?.(this.paneId, nextSessionKey);
              }
            }}
          >
            ${options.map(
              (row) => html`
                <option value=${row.key}>
                  ${resolveSessionDisplayName(
                    row.key,
                    sessions.find((session) => session.key === row.key),
                  )}
                </option>
              `,
            )}
          </select>
        </label>
        <div class="chat-pane__actions">
          ${this.onSplitDown
            ? html`
                <openclaw-tooltip .content=${t("chat.splitView.splitDown")}>
                  <button
                    class="btn btn--ghost btn--icon"
                    type="button"
                    aria-label=${t("chat.splitView.splitDown")}
                    @click=${() => this.onSplitDown?.(this.paneId)}
                  >
                    ${icons.panelBottomOpen}
                  </button>
                </openclaw-tooltip>
              `
            : null}
          ${this.onSplitRight
            ? html`
                <openclaw-tooltip .content=${t("chat.splitView.splitRight")}>
                  <button
                    class="btn btn--ghost btn--icon"
                    type="button"
                    aria-label=${t("chat.splitView.splitRight")}
                    @click=${() => this.onSplitRight?.(this.paneId)}
                  >
                    ${icons.panelRightOpen}
                  </button>
                </openclaw-tooltip>
              `
            : null}
          ${this.onClosePane
            ? html`
                <openclaw-tooltip .content=${t("chat.splitView.closePane")}>
                  <button
                    class="btn btn--ghost btn--icon"
                    type="button"
                    aria-label=${t("chat.splitView.closePane")}
                    @click=${() => this.onClosePane?.(this.paneId)}
                  >
                    ${icons.x}
                  </button>
                </openclaw-tooltip>
              `
            : null}
        </div>
      </div>
    `;
  }

  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const currentAgentId = resolveChatAgentId(state);
    const agentDefaultModel = this.context.agents.state.agentsList?.agents.find(
      (agent) => agent.id === currentAgentId,
    )?.model?.primary;
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
      paneId: this.paneId,
      sessionKey: state.sessionKey,
      onSessionKeyChange: (next) => {
        this.onPaneSessionChange?.(this.paneId, next);
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
      sendShortcut: state.settings.chatSendShortcut,
      draft: state.chatMessage,
      queue: state.chatQueue,
      realtimeTalkActive: state.realtimeTalkActive,
      realtimeTalkStatus: state.realtimeTalkStatus,
      realtimeTalkDetail: state.realtimeTalkDetail,
      realtimeTalkConversation: state.realtimeTalkConversation,
      connected: state.connected,
      canSend: state.connected && !selectedSessionArchived,
      disabledReason,
      error: state.lastError,
      sessions: state.sessionsResult,
      providerQuota: {
        basePath: state.basePath,
        modelAuthStatusResult: state.modelAuthStatusResult,
      },
      composerControls: renderChatControls({
        paneId: this.paneId,
        agentsList: state.agentsList,
        connected: state.connected,
        hideCronSessions: state.sessionsHideCron,
        loading: state.chatLoading,
        manualRefreshInFlight: state.chatManualRefreshInFlight,
        model: {
          activeRunId: state.chatRunId,
          agentDefaultModel,
          connected: state.connected,
          draftScope: state,
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
          onRequestUpdate: () => state.requestUpdate?.(),
          onFastModeSelect: (next, targetSessionKey) =>
            switchChatFastMode(state, next, targetSessionKey),
          onModelSelect: (next, targetSessionKey) => switchChatModel(state, next, targetSessionKey),
          onThinkingSelect: (next, targetSessionKey) =>
            switchChatThinkingLevel(state, next, targetSessionKey),
        },
        onboarding: state.onboarding,
        runId: state.chatRunId,
        sending: state.chatSending,
        settings: state.settings,
        settingsOpen: state.chatMobileControlsOpen,
        sessionKey: state.sessionKey,
        sessionsResult: state.sessionsResult,
        stream: state.chatStream,
        realtimeTalkOptions: state.realtimeTalkOptions,
        realtimeTalkInputDevices: state.realtimeTalkInputDevices,
        realtimeTalkInputDeviceId: state.realtimeTalkInputDeviceId,
        realtimeTalkInputLoading: state.realtimeTalkInputLoading,
        realtimeTalkInputError: state.realtimeTalkInputError,
        canOpenRealtimeTalkSettings,
        onRefresh: () => handleChatManualRefresh(state),
        onRealtimeTalkInputRefresh: () => void state.refreshRealtimeTalkInputs(true),
        onRealtimeTalkInputSelect: state.selectRealtimeTalkInput,
        onRealtimeTalkOptionsChange: state.updateRealtimeTalkOptions,
        onOpenRealtimeTalkSettings: () => {
          if (!canOpenRealtimeTalkSettings) {
            return;
          }
          this.context.navigate("communications", { search: "?section=talk" });
        },
        onSettingsChange: state.applySettings,
        onSettingsOpenChange: (open, options) => {
          state.setChatMobileControlsOpen(open, options);
          if (open) {
            void state.refreshRealtimeTalkInputs(false);
          }
        },
        onToggleCronSessions: () => {
          state.sessionsHideCron = !state.sessionsHideCron;
          state.requestUpdate?.();
        },
        onOpenSplitView: this.onOpenSplitView,
      }),
      sessionWorkspace: createSessionWorkspaceProps(state),
      onOpenWorkspaceFile: (target) => openSessionWorkspaceFile(state, target),
      onRevealWorkspaceFile: (path) => revealSessionWorkspaceFile(state, path),
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
      onGoalCommand: (command) => void state.handleSendChat(command),
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
        const nextSessionKey = buildAgentMainSessionKey({ agentId });
        this.onPaneSessionChange?.(this.paneId, nextSessionKey);
      },
      onSessionSelect: (next) => {
        this.onPaneSessionChange?.(this.paneId, next);
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
    return html`${this.renderPaneHeader(state)}${renderChat(props)}`;
  }
}

if (!customElements.get("openclaw-chat-pane")) {
  customElements.define("openclaw-chat-pane", ChatPane);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pane": ChatPane;
  }
}
