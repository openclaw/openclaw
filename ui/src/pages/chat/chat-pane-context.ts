import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import type { ExecApprovalDecision } from "../../app/exec-approval.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { SHELL_APPROVALS_OPEN_EVENT } from "../../app/lazy-shell-action.ts";
import { hasOperatorSelfReadAccess } from "../../app/operator-access.ts";
import {
  browserPanelSurfaceUnavailableReason,
  isDesktopPanelAvailable,
} from "../../app/panel-availability.ts";
import { canUseQuestionPrompts } from "../../app/question-prompt-client.ts";
import {
  listQuestionPrompts,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
  type QuestionPrompt,
} from "../../app/question-prompt.ts";
import { loadSettings } from "../../app/settings.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import type { SessionPlacementPresentation } from "../../components/session-placement-move-dialog.tsx";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey } from "../../lib/sessions/navigation.ts";
import {
  canonicalUiSessionKeyForPersistence,
  isUiSelectedGlobalSessionKey,
  parseAgentSessionKey,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../../lib/terminal-availability.ts";
import { invalidateChatAvatarCache } from "./chat-avatar.ts";
import {
  getChatHistoryLoadState,
  synchronizeInitialChatSnapshotConnection,
} from "./chat-history-state.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { applyChatAgentsList, resumePendingChatHistoryLoad } from "./chat-history.ts";
import { ChatPaneLifecycle } from "./chat-pane-lifecycle.ts";
import { resolvePlacementComposer } from "./chat-pane-placement.ts";
import { dismissChatError } from "./chat-pane-state.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { retireChatModelSelectionOwnership } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  refreshChatModelAuthStatus,
  readChatRequiredWorkerInferenceProfileId,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { HumanMentionAccess } from "./components/chat-composer-mention-menu-state.ts";
import { releaseChatMediaResourceOwner } from "./components/chat-message-media.ts";
import { retireSessionWorkspaceCheckout } from "./components/chat-session-workspace.ts";
import { retireChatPairingQr } from "./history-merge.ts";
import { reconcileChatRunLifecycle, replayPendingChatAbort } from "./run-lifecycle.ts";
import { cancelChatScroll } from "./scroll.ts";
import { currentInlineSessionApproval } from "./session-approval-projection.ts";
import { retireCachedPairingQr } from "./session-message-cache.ts";
import { migrateLegacyDockVisibility } from "./sidebar-layout-legacy-migration.ts";
import { normalizeSidebarLayout } from "./sidebar-layout.ts";
import { reconcileWaitingApprovalsFromSnapshot } from "./tool-stream-snapshot.ts";
import { resetToolStream } from "./tool-stream-state.ts";

export abstract class ChatPaneContext extends ChatPaneLifecycle {
  private registeredHumanMentionAccess?: HumanMentionAccess;
  protected readonly getHumanMentionAccess = () => this.registeredHumanMentionAccess;
  protected readonly registerHumanMentionAccess = (access: HumanMentionAccess) => {
    this.registeredHumanMentionAccess = access;
    return () => {
      if (this.registeredHumanMentionAccess !== access) {
        return;
      }
      this.registeredHumanMentionAccess = undefined;
    };
  };

  private pairingPresentationOwner?: ReturnType<typeof gatewayPresentationScope>;
  private gatewayConnectionLifecycle?: ReturnType<typeof createGatewayConnectionLifecycle>;
  private outboxRecoveryReady = false;
  private gatewayReadsAvailable = false;
  private sidebarLayoutSource?: { client: ApplicationGatewaySnapshot["client"]; ready: boolean };
  private questionProjection: { prompts: QuestionPrompt[]; revisions: number[] } = {
    prompts: [],
    revisions: [],
  };
  protected placementComposerPresentation(
    row: GatewaySessionRow | undefined,
    startupPending: boolean,
  ) {
    return resolvePlacementComposer({
      gatewaySnapshot: this.context.gateway.snapshot,
      requiredProfile: this.context.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
      movingKey: this.headerPresentation.placementMovingKey,
      reclaimingKey: this.headerPresentation.placementReclaimingKey,
      restartingKey: this.headerPresentation.placementRestartingKey,
      row,
      startupPending,
      requiredWorkerInferenceProfileId: this.state
        ? readChatRequiredWorkerInferenceProfileId(this.state)
        : undefined,
      workspaceResultReconciling:
        (row?.placement?.state === "active" || row?.placement?.state === "draining") &&
        row.placement.workspaceResultReconciling === true,
      onRecover: () => row && void this.changeHeaderPlacement(row, "recover"),
      onReclaim: () => row && void this.changeHeaderPlacement(row, "reclaim"),
      onRetryMove: () => row && void this.changeHeaderPlacement(row, "move"),
    });
  }

  override dispose() {
    this.registeredHumanMentionAccess = undefined;
    if (this.state) {
      retireChatPairingQr(this.state);
      retireCachedPairingQr(this.state.chatMessagesBySession);
    }
    this.pairingPresentationOwner = undefined;
    this.headerPresentation.continueInTerminalDialog = null;
    this.gatewayConnectionLifecycle?.dispose();
    this.gatewayConnectionLifecycle = undefined;
    this.outboxRecoveryReady = false;
    super.dispose();
  }

  protected async changeHeaderPlacement(
    row: GatewaySessionRow,
    mode: "move" | "recover" | "reclaim",
    presentation?: SessionPlacementPresentation,
    machineName?: string,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const pendingProperty = {
      move: "placementMovingKey",
      recover: "placementRestartingKey",
      reclaim: "placementReclaimingKey",
    } as const;
    const property = pendingProperty[mode];
    const pendingKey = this.headerPresentation[property];
    const onPendingChange = (key: string | null) => {
      if (mode === "recover" && key !== null && this.state) {
        dismissChatError(this.state);
        this.state.chatRunError = null;
      }
      // Only the request that still owns the row may clear its progress key.
      if (key !== null || this.headerPresentation[property] === row.key) {
        this.headerPresentation[property] = key;
      }
    };
    const params = {
      client: scope.client,
      gatewaySnapshot: scope.context.gateway.snapshot,
      currentGatewaySnapshot: () => scope.context.gateway.snapshot,
      row,
      currentRow: () => {
        const current = this.state ? selectedChatSessionRow(this.state) : undefined;
        return current?.key === row.key ? current : undefined;
      },
      fallbackAgentId: resolveChatAgentId(scope.state),
      isCurrent: () => this.ownsHeaderOutcomeScope(scope),
      publishError: (error: unknown) => this.publishHeaderError(error, scope.headerOutcomeOwner),
      reconcileMutation: (agentId?: string | null) => scope.sessions.reconcileMutation(agentId),
    };
    try {
      if (mode === "reclaim") {
        const { reclaimChatPanePlacement } = await import("./chat-pane-placement.runtime.ts");
        return await reclaimChatPanePlacement({
          ...params,
          machineName,
          reclaimingKey: pendingKey,
          placementStartup: scope.context.placementStartup,
          onReclaimingChange: onPendingChange,
        });
      }
      const { changeSessionPlacement } =
        await import("../../components/session-placement.runtime.ts");
      await changeSessionPlacement({
        ...params,
        mode,
        presentation,
        pendingKey,
        requiredProfile: () =>
          scope.context.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
        onPendingChange,
      });
    } catch (error) {
      params.publishError(error);
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
    const questions = visible
      ? listQuestionPrompts(this.questionPromptState).filter(matchesConversation)
      : [];
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
    const overlays = this.context.overlays;
    const snapshot = overlays?.snapshot;
    const inlineApproval = visible
      ? currentInlineSessionApproval(state, agentId, snapshot?.approvalQueue, matchesConversation)
      : null;
    return {
      gatewayQuestionPrompts: this.questionProjection.prompts,
      inlineApproval,
      approvalBusy: snapshot?.approvalBusy,
      approvalCanGrant: snapshot?.approvalCanGrant ?? false,
      approvalErrors: snapshot?.approvalErrors,
      approvalNodeNames: snapshot?.approvalNodeNames,
      approvalPendingCount:
        snapshot?.approvalQueue.filter((entry) => entry.id !== inlineApproval?.id).length ?? 0,
      onOpenPendingApprovals:
        overlays && visible
          ? () => {
              if (overlays.snapshot.approvalQueue.length > 0) {
                window.dispatchEvent(new CustomEvent(SHELL_APPROVALS_OPEN_EVENT));
              }
            }
          : undefined,
      onApprovalDecision:
        overlays && visible
          ? (approvalId: string, decision: ExecApprovalDecision) =>
              overlays.decideApproval(decision, approvalId, inlineApproval ?? undefined)
          : undefined,
    };
  }

  protected applyApplicationConfig(config: ApplicationContext["config"]["current"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    state.terminalAvailable = isTerminalAvailable(
      this.context.gateway.snapshot,
      config.terminalEnabled,
    );
    state.embedSandboxMode = config.embedSandboxMode;
    state.allowExternalEmbedUrls = config.allowExternalEmbedUrls;
    state.automaticallyFetchFavicons = config.automaticallyFetchFavicons;
  }

  protected applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousMediaAuthToken = resolveControlUiAuthToken(state);
    const presentationOwner = gatewayPresentationScope(this.context.gateway);
    const pairingOwnerChanged =
      this.pairingPresentationOwner !== undefined &&
      this.pairingPresentationOwner !== presentationOwner;
    this.pairingPresentationOwner = presentationOwner;
    const readsAvailable = isGatewayAvailable(snapshot);
    const readsResumed = readsAvailable && !this.gatewayReadsAvailable;
    this.gatewayReadsAvailable = readsAvailable;
    const wasConnected = state.connected;
    const previousAssistantAgentId = state.assistantAgentId;
    // Gateway identity is its default, while each retained pane owns its routed agent.
    const assistantAgentId =
      parseAgentSessionKey(state.sessionKey)?.agentId ??
      this.agentId ??
      this.context.agentSelection.state.selectedId ??
      snapshot.assistantAgentId;
    const previousSidebarSessionKey = canonicalUiSessionKeyForPersistence(state, state.sessionKey);
    const sourceChanged = (this.gatewayConnectionLifecycle ??= createGatewayConnectionLifecycle({
      client: state.client,
      phase: state.connected ? "connected" : "stopped",
    })).transition(snapshot);
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
      this.presence.update(undefined);
    } else if (clientChanged || !wasConnected) {
      const presence = readPresenceEntries(snapshot.hello?.snapshot);
      this.presence.update({ presence: presence ?? [] });
    }
    const rename = this.headerPresentation.renameSession;
    const draftOwnerChanged = state.client !== snapshot.client || pairingOwnerChanged;
    if (
      draftOwnerChanged ||
      (snapshot.phase === "connected" &&
        !readSessionMethodAccess(snapshot, {
          method: "sessions.groups.put",
          requiredScope: "operator.write",
        }).allowed)
    ) {
      this.retireHeaderSessionDrafts();
    }
    if (
      draftOwnerChanged ||
      (rename &&
        snapshot.phase === "connected" &&
        !readSessionMethodAccess(snapshot, {
          method: "sessions.patch",
          params: { key: rename.key, label: null },
          sessionScope: true,
          session: state.sessionsResult?.sessions.find(
            (row) => row.key === rename.key && row.sessionId === rename.sessionId,
          ),
        }).allowed)
    ) {
      this.cancelHeaderRename();
    }
    const reactionOwnerChanged =
      pairingOwnerChanged ||
      snapshot.client?.offlineRecoveryRetired === true ||
      (snapshot.phase === "connected" && !hasOperatorSelfReadAccess(snapshot.hello?.auth ?? null));
    const metadataOwnerChanged = state.client !== snapshot.client || reactionOwnerChanged;
    if (sourceChanged || metadataOwnerChanged) {
      retireChatMetadataRequests(state, { keepPresentation: !metadataOwnerChanged });
    }
    if (draftOwnerChanged || reactionOwnerChanged) {
      this.sessionCompanionThreads.retire();
    }
    if (sourceChanged) {
      this.retireDetailsOutputs();
      this.resetSessionReadAcknowledgements();
      this.headerPresentation.continueInTerminalDialog = null;
      cancelChatScroll(state);
      releaseChatMediaResourceOwner(state);
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
      this.taskSuggestionsRequestVersion += 1;
      this.resetSessionSuggestions();
      if (reactionOwnerChanged) {
        this.resetSessionReactions();
      }
      this.clearTypingActors();
      this.sessionDiscussion.clear();
      this.sessionDiscussionPanels.clear();
      this.sessionParticipationTracker.reset();
      if (state.client !== snapshot.client) {
        // Local run identities belong to the previous client, even if the new
        // Gateway uses the same session key. Never bind its offline Stop to them.
        reconcileChatRunLifecycle(state, {
          clearLocalRun: true,
          clearToolStream: true,
          clearRunStatus: true,
          publishRunState: false,
        });
        state.pendingAbort = null;
      }
      // A new gateway/account owns its own membership + identity data; drop the
      // previous connection's sharing cache so a stale loading entry cannot
      // suppress the fresh load or leak the prior account's identities.
      this.collaboration.sharingStates = new Map();
      this.sessionSharingHydrationTargets.clear();
      state.chatSessionApprovalQueue = [];
      state.chatSessionApprovalReplay = undefined;
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
      this.swarm.hydrator?.dispose();
      this.swarm.hydrator = null;
    }
    state.client = snapshot.client;
    state.connected = snapshot.phase === "connected";
    state.gatewayWorkPaused = state.connected && !readsAvailable;
    synchronizeInitialChatSnapshotConnection(state);
    const recoveryReady = readsAvailable && Boolean(state.client?.recoveryScopeReady);
    const resumeOutboxes = recoveryReady && (clientChanged || !this.outboxRecoveryReady);
    this.outboxRecoveryReady = recoveryReady;
    state.connectionEpoch = this.connectionGeneration;
    state.hello = snapshot.hello;
    state.selfUser = snapshot.selfUser ?? null;
    state.assistantAgentId = assistantAgentId;
    this.refreshBoardSubscriptions();
    const routeSessionKey = this.sessionKey.trim();
    const catalogRouteKey = parseCatalogSessionKey(routeSessionKey);
    if (
      snapshot.client &&
      (state.connected || snapshot.phase === "connecting" || snapshot.phase === "reconnecting") &&
      !catalogRouteKey &&
      (sourceChanged || this.connectedClient !== snapshot.client)
    ) {
      void syncSelectedSessionMessageSubscription(state, {
        force: true,
        initialHistory: true,
        beforeHello: !state.connected,
      });
    }
    this.reconcileTaskSuggestionConnection(sourceChanged);
    this.synchronizeSessionObservation();
    if (readsResumed && !sourceChanged && this.presented) {
      this.markSessionRead(selectedChatSessionRow(state));
    }
    if (!state.connected && (wasConnected || sourceChanged)) {
      // The first client can arrive after startup is already waiting for it.
      // Preserve that loading intent; repeated disconnected snapshots stay no-ops.
      state.chatLoading = getChatHistoryLoadState(state).phase === "pending-connection";
    }
    const resumedHistory =
      !wasConnected && state.connected ? resumePendingChatHistoryLoad(state) : undefined;
    if (sourceChanged) {
      retireSessionWorkspaceCheckout(state);
    }
    const mediaAuthChanged = previousMediaAuthToken !== resolveControlUiAuthToken(state);
    if (sourceChanged || pairingOwnerChanged || mediaAuthChanged) {
      retireChatPairingQr(state);
      retireCachedPairingQr(state.chatMessagesBySession);
    }
    if (!sourceChanged && mediaAuthChanged) {
      releaseChatMediaResourceOwner(state);
    }
    state.canvasPluginSurfaceUrl = snapshot.canvasPluginSurfaceUrl;
    state.terminalAvailable = isTerminalAvailable(
      snapshot,
      this.context.config.current.terminalEnabled,
    );
    const browserUnavailableReason = browserPanelSurfaceUnavailableReason(snapshot);
    state.browserPanelUnavailableReason = browserUnavailableReason;
    state.browserPanelAvailable = browserUnavailableReason === null;
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
        desktopAvailable: isDesktopPanelAvailable(snapshot),
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
    }
    if (state.connected && state.pendingAbort) {
      void replayPendingChatAbort(state);
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
      resetToolStream(state, { preserveStreamSegments: state.chatRunId !== null });
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
          this.refreshBoardSubscriptions();
        }
      };
      this.connectedClient = startupClient;
      const questionClient = canUseQuestionPrompts(snapshot) ? startupClient : null;
      setQuestionPromptClient(this.questionPromptState, questionClient);
      if (questionClient) {
        refreshPendingQuestionsWithRetry(this.questionPromptState, questionClient, clientIsCurrent);
      }
      this.headerPresentation.worktreePaths = new Map();
      this.headerPresentation.branches = new Map();
      this.headerPresentation.platform = null;
      if (catalogRouteKey) {
        void this.loadHeaderPlatform(startupClient, startupGeneration);
        void this.loadCatalogSession(catalogRouteKey, false);
        return;
      }
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
      void refreshChatModelAuthStatus(state);
      void state.loadAssistantIdentity();
      this.syncSessionSuggestionTarget(
        resolveChatAgentId(state) ?? "main",
        selectedChatSessionRow(state),
      );
    }
    // Hello precedes recovery readiness. Wake draft restoration and parked outboxes;
    // the shared admission check still holds any recovered initial turn.
    if (resumeOutboxes && !catalogRouteKey) {
      this.chatState.composerPersistence.persistChangedState();
      void resumeStoredChatOutboxes(state);
    }
    this.reconcileWaitingApprovalSnapshot();
  }
}
