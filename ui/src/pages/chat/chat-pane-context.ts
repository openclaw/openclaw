import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  isBrowserPanelSurfaceAvailable,
  isDesktopPanelAvailable,
} from "../../app/panel-availability.ts";
import {
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
  type QuestionPrompt,
} from "../../app/question-prompt.ts";
import { loadSettings } from "../../app/settings.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { modelAuthEventInvalidates } from "../../lib/model-auth-request-state.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  canonicalUiSessionKeyForPersistence,
  isUiSelectedGlobalSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { invalidateChatAvatarCache } from "./chat-avatar.ts";
import {
  getChatHistoryLoadState,
  synchronizeInitialChatSnapshotConnection,
} from "./chat-history-state.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { applyChatAgentsList, resumePendingChatHistoryLoad } from "./chat-history.ts";
import { ChatPaneLifecycle } from "./chat-pane-lifecycle.ts";
import { resolvePlacementComposer } from "./chat-pane-placement.ts";
import { chatSessionPresentationKey } from "./chat-pane-session-presentation.ts";
import { applySelectedSessionProjection, dismissChatError } from "./chat-pane-state.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { flushChatQueueForEvent, resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { retireChatModelSelectionOwnership } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  refreshChatModelAuthStatus,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { requestChatPageUpdate } from "./chat-state-render.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";
import { retireSessionWorkspaceCheckout } from "./components/chat-session-workspace.ts";
import { resetTaskDetail } from "./components/chat-task-detail-state.ts";
import {
  reconcileChatRunAfterSessionStatePublication,
  reconcileChatRunLifecycle,
  replayPendingChatAbort,
} from "./run-lifecycle.ts";
import { cancelChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";
import { migrateLegacyDockVisibility } from "./sidebar-layout-legacy-migration.ts";
import { normalizeSidebarLayout } from "./sidebar-layout.ts";
import { maybeResetToolStream } from "./stream-reconciliation.ts";
import { reconcileWaitingApprovalsFromSnapshot } from "./tool-stream-status.ts";

export abstract class ChatPaneContext extends ChatPaneLifecycle {
  private sessionPresentationKey: string | undefined;
  private gatewayConnectionLifecycle?: ReturnType<typeof createGatewayConnectionLifecycle>;
  private outboxRecoveryReady = false;
  private sidebarLayoutSource?: { client: ApplicationGatewaySnapshot["client"]; ready: boolean };
  private questionProjection: { prompts: QuestionPrompt[]; revisions: number[] } = {
    prompts: [],
    revisions: [],
  };
  // Capability identity matters because a replacement restarts its canonical revision at zero.
  private canonicalSessionList?: {
    sessions: ApplicationContext["sessions"];
    revision: number;
    outboxState?: string;
  };

  constructor() {
    super();
    void new SubscriptionsController(this).effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          const state = this.state;
          if (!state || !modelAuthEventInvalidates(event)) {
            return;
          }
          state.modelAuthStatusResult = null;
          state.modelAuthStatusError = null;
          this.requestUpdate();
          void refreshChatModelAuthStatus(state).finally(() => this.requestUpdate());
        }),
    );
  }

  protected placementComposerPresentation(
    row: GatewaySessionRow | undefined,
    startupPending: boolean,
  ) {
    return resolvePlacementComposer({
      gatewaySnapshot: this.context.gateway.snapshot,
      movingKey: this.headerPlacementMovingKey,
      reclaimingKey: this.headerPlacementReclaimingKey,
      restartingKey: this.headerPlacementRestartingKey,
      row,
      startupPending,
      workspaceResultReconciling:
        (row?.placement?.state === "active" || row?.placement?.state === "draining") &&
        row.placement.workspaceResultReconciling === true,
      onRecover: () => row && void this.changeHeaderPlacement(row, "recover"),
      onReclaim: () => row && void this.reclaimHeaderPlacement(row),
    });
  }

  override disconnectedCallback() {
    this.sessionPresentationKey = undefined;
    this.continueInTerminalDialog = null;
    this.gatewayConnectionLifecycle?.dispose();
    this.gatewayConnectionLifecycle = undefined;
    this.outboxRecoveryReady = false;
    super.disconnectedCallback();
  }

  protected async changeHeaderPlacement(
    row: GatewaySessionRow,
    mode: "move" | "recover",
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const pendingProperty =
      mode === "move" ? "headerPlacementMovingKey" : "headerPlacementRestartingKey";
    const onPendingChange = (key: string | null) => {
      if (mode === "recover" && key !== null && this.state) {
        dismissChatError(this.state);
        this.state.chatRunError = null;
      }
      if (key !== null || this[pendingProperty] === row.key) {
        this[pendingProperty] = key;
      }
    };
    const params = {
      client: scope.client,
      connectionGeneration: scope.generation,
      gatewaySnapshot: scope.context.gateway.snapshot,
      mode,
      pendingKey: this[pendingProperty],
      row,
      isCurrent: () => this.ownsHeaderOutcomeScope(scope),
      currentRow: () => (this.state ? selectedChatSessionRow(this.state) : undefined),
      onPendingChange,
      publishError: (error: unknown) => this.publishHeaderError(error, scope.headerOutcomeOwner),
      reconcileMutation: (agentId?: string | null) => scope.sessions.reconcileMutation(agentId),
      requestUpdate: () => this.requestUpdate(),
    };
    const { changeChatPanePlacement } = await import("./chat-pane-placement.runtime.ts");
    await changeChatPanePlacement(params);
  }

  protected async reclaimHeaderPlacement(row: GatewaySessionRow): Promise<void> {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const onReclaimingChange = (reclaimingKey: string | null) => {
      // A later reclaim may take ownership before this request settles. Only
      // the request that still owns the row may clear the pane's progress key.
      if (reclaimingKey !== null || this.headerPlacementReclaimingKey === row.key) {
        this.headerPlacementReclaimingKey = reclaimingKey;
      }
    };
    const params = {
      client: scope.client,
      connectionGeneration: scope.generation,
      gatewaySnapshot: scope.context.gateway.snapshot,
      reclaimingKey: this.headerPlacementReclaimingKey,
      placementStartup: scope.context.placementStartup,
      row,
      isCurrent: () => this.ownsHeaderOutcomeScope(scope),
      onReclaimingChange,
      publishError: (error: unknown) => this.publishHeaderError(error, scope.headerOutcomeOwner),
      reconcileMutation: (agentId?: string | null) => scope.sessions.reconcileMutation(agentId),
      requestUpdate: () => this.requestUpdate(),
    };
    const { reclaimChatPanePlacement } = await import("./chat-pane-placement.runtime.ts");
    await reclaimChatPanePlacement(params);
  }

  protected applySessionsState(stateValue: ApplicationContext["sessions"]["state"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const canonicalListRevision = this.context.sessions.canonicalListRevision;
    const previousCanonical = this.canonicalSessionList;
    const canonicalListPublished =
      previousCanonical?.sessions === this.context.sessions &&
      canonicalListRevision > previousCanonical.revision;
    const selectedSessionDeleted = this.context.sessions.deletionState(
      state.sessionKey,
      resolveChatAgentId(state),
    );
    for (const { key, agentId } of stateValue.deletedSessions) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey: key, agentId });
    }
    // A list for another agent must not overwrite this pane's global history.
    if (
      !isUiSelectedGlobalSessionKey(state, state.sessionKey) ||
      stateValue.agentId === resolveChatAgentId(state)
    ) {
      state.sessionsResult = stateValue.result;
      state.sessionsResultAgentId = stateValue.agentId;
    }
    this.projectObservedSessionRow();
    state.sessionsLoading = stateValue.loading;
    state.sessionsError = stateValue.error;
    if (state.connected && state.pendingAbort) {
      void replayPendingChatAbort(state).finally(() => state.requestUpdate?.());
    }
    this.refreshSwarmRoster();
    const selectedSession = selectedChatSessionRow(state);
    const outboxState = selectedSession
      ? JSON.stringify([
          state.sessionKey,
          resolveChatAgentId(state),
          selectedSession.sessionId,
          selectedSession.status,
          isSessionRunActive(selectedSession),
          selectedSession.lastRunId,
          selectedSession.activeLeafEntryId,
        ])
      : undefined;
    this.canonicalSessionList = {
      sessions: this.context.sessions,
      revision: canonicalListRevision,
      outboxState: canonicalListPublished
        ? outboxState
        : previousCanonical?.sessions === this.context.sessions
          ? previousCanonical.outboxState
          : undefined,
    };
    if (applySelectedSessionProjection(state, selectedSession)) {
      // Hidden retained panes keep this subscription alive; only the pane the
      // user is actually looking at may clear unread/attention state.
      if (this.presented) {
        this.markSessionRead(selectedSession);
      }
    }
    this.syncSessionSuggestionTarget(
      stateValue.agentId ?? resolveChatAgentId(state) ?? "main",
      selectedSession,
    );
    if (selectedSessionDeleted) {
      const agentId = resolveChatAgentId(state);
      this.onSessionDeleted?.(
        this.paneId,
        state.sessionKey,
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: this.context.agents.state.agentsList,
            hello: this.context.gateway.snapshot.hello,
          }),
        }),
        selectedSessionDeleted === "pending",
      );
      return;
    }
    const reconciledLocalCompletion = reconcileChatRunAfterSessionStatePublication(state);
    this.reconcileWaitingApprovalSnapshot();
    if (reconciledLocalCompletion) {
      void resumeStoredChatOutboxes(state);
      return;
    }
    const presentation = chatSessionPresentationKey(
      state,
      stateValue,
      selectedSession,
      this.context.overlays?.snapshot?.approvalQueue,
    );
    const presentationChanged = presentation !== this.sessionPresentationKey;
    this.sessionPresentationKey = presentation;
    if (this.presented && presentationChanged) {
      requestChatPageUpdate(state, "animation-frame");
    }
    // First canonical idle and changed run/branch identity can release a queue.
    // Re-decoding an unchanged row after foreign activity is not new delivery intent.
    if (
      canonicalListPublished &&
      previousCanonical?.outboxState !== outboxState &&
      selectedSession &&
      !isSessionRunActive(selectedSession) &&
      state.chatQueue.length > 0
    ) {
      void flushChatQueueForEvent(state);
    }
  }

  protected reconcileWaitingApprovalSnapshot(
    approvalQueue?: ApplicationContext["overlays"]["snapshot"]["approvalQueue"],
  ): boolean {
    const state = this.state;
    const queue = approvalQueue ?? this.context?.overlays?.snapshot.approvalQueue;
    if (!state || !queue) {
      return false;
    }
    return reconcileWaitingApprovalsFromSnapshot(state, queue);
  }

  protected projectConversationAttention(state: ChatPageHost, agentId: string, visible: boolean) {
    const matchesConversation = (request: {
      sessionKey?: string | null;
      agentId?: string | null;
    }) =>
      uiConversationMatches(state, state.sessionKey, request.sessionKey, request.agentId, agentId);
    const questions = visible ? this.questionPrompts.filter(matchesConversation) : [];
    // Question records mutate in place; their revisions own transcript-cache invalidation.
    if (
      questions.length !== this.questionProjection.prompts.length ||
      questions.some(
        (prompt, index) =>
          prompt !== this.questionProjection.prompts[index] ||
          prompt.revision !== this.questionProjection.revisions[index],
      )
    ) {
      this.questionProjection = {
        prompts: questions,
        revisions: questions.map((prompt) => prompt.revision),
      };
    }
    return {
      gatewayQuestionPrompts: this.questionProjection.prompts,
      // Session replay already owns the parent's presentation scope for delegated approvals.
      inlineApproval: visible
        ? (state.chatSessionApprovalQueue?.[0] ??
          this.context.overlays?.snapshot?.approvalQueue?.find((approval) =>
            matchesConversation(approval.request),
          ) ??
          null)
        : null,
    };
  }

  protected applyApplicationConfig(config: ApplicationContext["config"]["current"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousTerminalAvailable = state.terminalAvailable;
    state.terminalAvailable =
      config.terminalEnabled &&
      state.connected &&
      hasOperatorAdminAccess(state.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "terminal.open") === true;
    if (
      state.terminalAvailable === previousTerminalAvailable &&
      state.embedSandboxMode === config.embedSandboxMode &&
      state.allowExternalEmbedUrls === config.allowExternalEmbedUrls &&
      state.automaticallyFetchFavicons === config.automaticallyFetchFavicons
    ) {
      return;
    }
    state.embedSandboxMode = config.embedSandboxMode;
    state.allowExternalEmbedUrls = config.allowExternalEmbedUrls;
    state.automaticallyFetchFavicons = config.automaticallyFetchFavicons;
    state.requestUpdate?.();
  }

  protected applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousMediaAuthToken = resolveControlUiAuthToken(state);
    const wasConnected = state.connected;
    const previousAssistantAgentId = state.assistantAgentId;
    // Gateway identity is its default, while each retained pane owns its routed agent.
    const assistantAgentId =
      parseAgentSessionKey(state.sessionKey)?.agentId ??
      this.agentId ??
      this.context.agentSelection.state.selectedId ??
      snapshot.assistantAgentId;
    const previousSidebarSessionKey = canonicalUiSessionKeyForPersistence(state, state.sessionKey);
    const connectionLifecycle = (this.gatewayConnectionLifecycle ??=
      createGatewayConnectionLifecycle({
        client: state.client,
        phase: state.connected ? "connected" : "stopped",
      }));
    const sourceChanged = connectionLifecycle.transition(snapshot);
    const clientChanged = this.connectedClient !== snapshot.client;
    const layoutClientChanged = this.sidebarLayoutSource
      ? snapshot.client !== null && this.sidebarLayoutSource.client !== snapshot.client
      : state.client !== snapshot.client;
    const layoutSourceChanged =
      !this.sidebarLayoutSource ||
      layoutClientChanged ||
      (snapshot.phase === "connected" && !this.sidebarLayoutSource.ready);
    if (clientChanged) {
      this.replaceStagedAttachmentGatewayOwner(snapshot.client);
    }
    if (snapshot.phase !== "connected") {
      this.presencePayload = undefined;
    } else if (clientChanged || !wasConnected) {
      const presence = readPresenceEntries(snapshot.hello?.snapshot);
      this.presencePayload = presence ? { presence } : undefined;
    }
    if (sourceChanged) {
      this.continueInTerminalDialog = null;
      this.cancelHeaderRename();
      cancelChatScroll(state);
      releaseChatMediaResourceSubscriber(state.requestUpdate);
      if (wasConnected) {
        if (snapshot.phase === "connected") {
          markQueuedChatSendsWaitingForReconnect(state);
        }
        state.chatSending = false;
        state.chatSendingScopeKey = null;
      }
      // A reconnect can retain the browser client. Keep async ownership tied
      // to the logical connection, not only the transport object identity.
      this.connectionGeneration += 1;
      this.retireReplyMessages();
      this.retireHeaderSessionMutations();
      invalidateChatAvatarCache(state);
      state.assistantIdentityRequestVersion += 1;
      retireChatMetadataRequests(state);
      this.taskSuggestionsRequestVersion += 1;
      this.resetSessionSuggestions();
      this.clearTypingActors();
      this.sessionDiscussionStates.clear();
      this.sessionDiscussionOpenUrls.clear();
      this.sessionDiscussionPanels.clear();
      this.sessionParticipationTracker.reset();
      if (state.client !== snapshot.client) {
        this.sessionCompanionThreads.retire();
        // Local run identities belong to the previous client, even if the new
        // Gateway uses the same session key. Never bind its offline Stop to them.
        reconcileChatRunLifecycle(state, {
          clearLocalRun: true,
          clearChatStream: true,
          clearToolStream: true,
          clearRunStatus: true,
          requestUpdate: false,
        });
        state.pendingAbort = null;
      }
      // A new gateway/account owns its own membership + identity data; drop the
      // previous connection's sharing cache so a stale loading entry cannot
      // suppress the fresh load or leak the prior account's identities.
      this.sessionSharingStates = new Map();
      this.sessionSharingHydrationTargets.clear();
      state.guardianNotices = [];
      state.providerPolicyNotice = null;
      this.resetSessionPullRequests();
      this.resetOlderMessagesViewport();
      state.chatLoading = false;
    }
    if (
      sourceChanged ||
      (previousAssistantAgentId !== assistantAgentId &&
        isUiSelectedGlobalSessionKey(state, state.sessionKey))
    ) {
      retireChatModelSelectionOwnership(state);
      resetTaskDetail(state);
      this.swarmHydrator?.dispose();
      this.swarmHydrator = null;
    }
    state.client = snapshot.client;
    state.connected = snapshot.phase === "connected";
    synchronizeInitialChatSnapshotConnection(state);
    const recoveryReady = state.connected && Boolean(state.client?.recoveryScopeReady);
    const resumeOutboxes = recoveryReady && (clientChanged || !this.outboxRecoveryReady);
    this.outboxRecoveryReady = recoveryReady;
    state.connectionEpoch = this.connectionGeneration;
    state.hello = snapshot.hello;
    state.selfUser = snapshot.selfUser ?? null;
    state.assistantAgentId = assistantAgentId;
    this.reconcileTaskSuggestionConnection(sourceChanged);
    this.synchronizeSessionObservation();
    if (wasConnected && !state.connected) {
      // Only the connected->disconnected transition may reshape loading state;
      // repeated disconnected snapshots must stay no-ops for pane ownership.
      state.chatLoading = getChatHistoryLoadState(state).phase === "pending-connection";
    }
    const resumedHistory =
      !wasConnected && state.connected ? resumePendingChatHistoryLoad(state) : undefined;
    if (sourceChanged) {
      retireSessionWorkspaceCheckout(state);
    }
    if (!sourceChanged && previousMediaAuthToken !== resolveControlUiAuthToken(state)) {
      releaseChatMediaResourceSubscriber(state.requestUpdate);
    }
    state.canvasPluginSurfaceUrl = snapshot.canvasPluginSurfaceUrl;
    state.terminalAvailable =
      this.context.config.current.terminalEnabled &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "terminal.open") === true;
    state.browserPanelAvailable = isBrowserPanelSurfaceAvailable(snapshot);
    const desktopPanelAvailable = isDesktopPanelAvailable(snapshot);
    const sidebarSessionKey = canonicalUiSessionKeyForPersistence(state, state.sessionKey);
    const sidebarKeyChanged = sidebarSessionKey !== previousSidebarSessionKey;
    // Restore offline/compact preferences immediately, then migrate ready-only
    // panels once. A transport reconnect must not reload the active layout.
    if (sidebarSessionKey && (layoutSourceChanged || sidebarKeyChanged)) {
      this.sidebarLayoutSource = { client: snapshot.client, ready: state.connected };
      this.dashboardPresentationActivation = undefined;
      const sidebarSettings = migrateLegacyDockVisibility({
        settings: loadSettings(),
        sessionKey: sidebarSessionKey,
        browserAvailable: state.browserPanelAvailable,
        desktopAvailable: desktopPanelAvailable,
      });
      const persistedLayout = sidebarSettings.sidebarSessionLayouts?.[sidebarSessionKey];
      if (persistedLayout !== undefined) {
        state.sidebarLayout = this.restorePaneSidebarLayout(
          normalizeSidebarLayout(persistedLayout),
        );
      } else if (layoutClientChanged) {
        state.sidebarLayout = { columns: [] };
      } else if (sidebarKeyChanged && state.sidebarLayout.columns.length > 0) {
        state.updateSidebarLayout(state.sidebarLayout);
      }
      state.sidebarFocusPanelId =
        sidebarSettings.sidebarSessionActivePanels?.[sidebarSessionKey] ?? "";
      state.sidebarFocusVersion += 1;
    }
    if (state.connected && state.pendingAbort) {
      void replayPendingChatAbort(state).finally(() => state.requestUpdate?.());
    }
    const routeSessionKey = this.sessionKey.trim();
    const catalogRouteKey = parseCatalogSessionKey(routeSessionKey);
    if (
      sourceChanged &&
      snapshot.phase === "connected" &&
      state.sessionKey &&
      !clientChanged &&
      !catalogRouteKey
    ) {
      // A logical reconnect can retain the browser client and skip full startup.
      // Disconnect cleanup drops transient tool rows, so reload this pane's
      // active-run snapshot before secondary session surfaces hydrate.
      const historyRefresh = refreshPageChat(state, {
        startup: true,
        awaitHistory: true,
        deferBranches: true,
        historyLoad: resumedHistory,
      });
      this.deferSessionHydrationUntilTranscript(
        state.sessionKey,
        historyRefresh.then(() => getChatHistoryLoadState(state).phase === "committed"),
      );
    }
    const canonicalRouteSessionKey =
      routeSessionKey && !catalogRouteKey
        ? resolveSessionKey(routeSessionKey, snapshot.hello)
        : null;
    if (
      routeSessionKey &&
      canonicalRouteSessionKey &&
      canonicalRouteSessionKey !== routeSessionKey &&
      this.presented
    ) {
      this.onPaneSessionChange?.(this.paneId, canonicalRouteSessionKey, { replace: true });
      state.requestUpdate?.();
      // Persisted state may already own the canonical key; continue startup
      // because no later route update would load its history.
      if (state.sessionKey !== canonicalRouteSessionKey) {
        return;
      }
    }
    // Keep the session-specific identity loaded by agent.identity.get across
    // ordinary gateway snapshots. Reset to the configured fallback only when
    // the logical connection changes; the startup path refreshes the identity
    // for the active session afterward.
    if (sourceChanged) {
      state.assistantName = this.context.config.current.assistantIdentity.name;
    }
    if (snapshot.phase !== "connected") {
      if (wasConnected) {
        const currentSessionId =
          typeof state.currentSessionId === "string" ? state.currentSessionId.trim() : "";
        if (currentSessionId) {
          state.reconnectResumeSessionId = currentSessionId;
        }
        markQueuedChatSendsWaitingForReconnect(state);
      }
      this.connectedClient = null;
      setQuestionPromptClient(this.questionPromptState, null);
      stopChatRealtimeTalk(state);
      maybeResetToolStream(state, { preserveStreamSegments: state.chatRunId !== null });
      state.requestUpdate?.();
      return;
    }
    this.refreshSwarmRoster();
    // Route-binding effects above can synchronously publish a new snapshot and
    // re-enter this method; the inner application claims connectedClient, so the
    // stale outer clientChanged must not start a second duplicate startup.
    if (
      (this.connectedClient !== snapshot.client || (sourceChanged && catalogRouteKey)) &&
      snapshot.client
    ) {
      const startupClient = snapshot.client;
      const startupGeneration = this.connectionGeneration;
      const startupSessionKey = state.sessionKey;
      const clientIsCurrent = () =>
        this.connectionGeneration === startupGeneration &&
        this.connectedClient === startupClient &&
        state.client === startupClient &&
        state.connected;
      const finishStartup = async () => {
        if (!clientIsCurrent()) {
          return;
        }
        const agentsList = await this.context.agents.ensureList();
        if (!clientIsCurrent()) {
          return;
        }
        if (agentsList) {
          applyChatAgentsList(state, agentsList, startupClient);
        }
        state.requestUpdate?.();
      };
      this.connectedClient = startupClient;
      setQuestionPromptClient(this.questionPromptState, startupClient);
      refreshPendingQuestionsWithRetry(this.questionPromptState, startupClient, clientIsCurrent);
      this.headerWorktreePaths.clear();
      this.headerBranches.clear();
      this.headerPlatform = null;
      if (catalogRouteKey) {
        void this.loadHeaderPlatform(startupClient, startupGeneration);
        void this.loadCatalogSession(catalogRouteKey, false);
        state.requestUpdate?.();
        return;
      }
      void syncSelectedSessionMessageSubscription(state, { force: true });
      const historyRefresh = refreshPageChat(state, {
        startup: true,
        awaitHistory: true,
        deferBranches: true,
        historyLoad: resumedHistory,
      });
      this.deferSessionHydrationUntilTranscript(
        startupSessionKey,
        historyRefresh.then(() => getChatHistoryLoadState(state).phase === "committed"),
      );
      void historyRefresh.finally(() => {
        void finishStartup();
      });
      void refreshChatModelAuthStatus(state).finally(() => state.requestUpdate?.());
      void state.loadAssistantIdentity();
      void this.refreshSessionSuggestions();
    }
    // Hello precedes recovery readiness. Wake parked outboxes on that publication;
    // the shared admission check still holds any recovered initial turn.
    if (resumeOutboxes && !catalogRouteKey) {
      void resumeStoredChatOutboxes(state);
    }
    this.reconcileWaitingApprovalSnapshot();
    state.requestUpdate?.();
  }
}
