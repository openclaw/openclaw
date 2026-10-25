import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { patchSettings } from "../../app/settings.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../../app/user-profile.ts";
import { navigateMarkdownSession } from "../../components/markdown-session-links.ts";
import { personActivityRouting } from "../../components/person-activity-link.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  pickFreshestObserverDigest,
  projectSessionObserverDigest,
  resolveChatPaneObserverRunId,
} from "../../lib/observer-digest.ts";
import { hasSessionPresenceViewers } from "../../lib/presence-users.ts";
import { readSessionMethodScopeAccess } from "../../lib/session-method-access.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";
import { navigateToModelProvider } from "../model-providers/navigation.ts";
import { isChatBubbleMode } from "./chat-bubble-mode.ts";
import { chatGoalRecovery, mutateChatGoal, submitChatGoalDraft } from "./chat-goals.ts";
import { isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import { resolveChatModelSetup } from "./chat-model-setup.ts";
import { ChatPaneLayoutRender } from "./chat-pane-layout-render.ts";
import { synchronizeChatPanePublication } from "./chat-pane-publication.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import { chatPaneResourceProps } from "./chat-pane-resource-presentation.ts";
import {
  createChatPaneQueuedEditProps,
  createChatPaneSessionActionCallbacks,
  canDismissChatPendingInputs,
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import {
  createSidebarFullMessageLoader,
  resolveSidebarLayoutForBoard,
} from "./chat-pane-sidebar-layout.ts";
import {
  chatSubmitState,
  createChatPaneSendActions,
  createChatPaneRunRecoveryActions,
  dismissChatError,
  resolveChatPaneFollowUpMode,
} from "./chat-pane-state.ts";
import type { ChatProviderReviewOwner } from "./chat-provider-review-controller.tsx";
import { createChatQuestionActions } from "./chat-question-actions.ts";
import { dismissRealtimeTalkError } from "./chat-realtime.ts";
import { activeChatRunStartupStatus } from "./chat-run-startup.ts";
import { chatSendPendingReason } from "./chat-send-support.ts";
import { refreshChatCommands } from "./chat-state-refresh.ts";
import {
  resolveChatAgentId,
  resolveChatAvatarUrl,
  selectedChatSessionRow,
} from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view.tsx";
import { openSessionWorkspaceFile } from "./components/chat-session-workspace.ts";
import { chatFailureRunId, hasAbortableSessionRun, hasDirectSessionRun } from "./run-lifecycle.ts";
import { lockChatScroll, scheduleChatScroll } from "./scroll.ts";
import { createChatWidgetLayout } from "./session-message-cache.ts";
import { resolveChatProjectionRunId } from "./tool-stream-snapshot.ts";
import { workspaceResultConflictFromPlacement } from "./workspace-conflict.ts";

registerChatSessionEnglish();

// Catalog panes have no live run; stable empty inputs preserve their transcript cache.
const emptyTranscriptItems: [] = [];

export class ChatPaneRuntime extends ChatPaneLayoutRender {
  render(readProviderReview?: () => ChatProviderReviewOwner | undefined) {
    const state = this.state;
    if (!state) {
      return { layout: null, capabilityDialogs: undefined, providerReviewSource: undefined };
    }
    const selectionConnectionGeneration = this.connectionGeneration;
    const selectedSession = selectedChatSessionRow(state);
    const providerPaused = Boolean(selectedSession?.providerReview);
    const childRoster = this.projectChildRoster(this.resolveChatReadTarget());
    const progressPresentation = this.progressCardPresentation;
    const selectedSessionArchived = this.isCurrentSessionArchived(state);
    const mutationAccess = readChatPaneMutationAccess(
      this.context.gateway.snapshot,
      state.sessionKey,
      selectedSession,
    );
    const observerDigest = pickFreshestObserverDigest(
      state.observerDigest,
      projectSessionObserverDigest(
        selectedSession?.key ?? state.sessionKey,
        selectedSession?.observerDigest,
      ),
    );
    const observerRunId = resolveChatPaneObserverRunId({
      localRunId: state.chatRunId,
      session: selectedSession,
      digest: observerDigest,
    });
    const workspaceConflict = workspaceResultConflictFromPlacement(selectedSession?.placement);
    const placement = selectedSession?.placement;
    const visibleWorkspaceConflict =
      workspaceConflict &&
      this.workspaceConflicts.dismissedRefs.get(selectedSession?.key ?? state.sessionKey) !==
        workspaceConflict.stagedResultRef
        ? workspaceConflict
        : undefined;
    const board = this.resolveBoardView();
    const sidebarLayout = resolveSidebarLayoutForBoard({
      board,
      layout: state.sidebarLayout,
      paneWidth: this.paneWidth,
    });
    state.chatFollowUpMode = resolveChatPaneFollowUpMode(
      state,
      selectedSession,
      this.context.runtimeConfig.state,
    );
    const currentAgentId = resolveChatAgentId(state);
    const catalogKey = parseCatalogSessionKey(state.sessionKey);
    const catalog = catalogKey !== null;
    const selectedAgent = this.context.agents.state.agentsList?.agents.find(
      (agent) => agent.id === currentAgentId,
    );
    const agentDefaultModel = selectedAgent?.model?.primary;
    const { modelSetupRequired, modelUnavailableBanner, requiredReason } = resolveChatModelSetup({
      activeSession: selectedSession,
      chatModelCatalog: state.chatModelCatalog,
      modelOverrides: state.sessions.state.modelOverrides,
      sessionKey: state.sessionKey,
      sessionsResult: state.sessionsResult,
      catalog,
      connected: state.connected,
      agentsLoaded: this.context.agents.state.agentsList !== null,
      selectedAgentFound: selectedAgent !== undefined,
      agentModel: agentDefaultModel,
      modelSelectionPolicy: state.chatModelSelectionPolicy,
      catalogRetired: state.chatModelCatalogRetired,
      catalogInitialized: state.chatModelCatalogInitialized,
      catalogError: state.chatModelCatalogError,
      onSetup: () => this.context.navigate("model-setup"),
    });
    const placementStartup = this.context.placementStartup.get(state.sessionKey);
    const pendingReason = chatSendPendingReason(state, state.sessionKey, placementStartup !== null);
    const runActive = hasDirectSessionRun(state);
    const sessionParticipationBlocked = this.sessionParticipationTracker.resolve({
      catalog,
      listLoading: state.sessionsLoading,
      sessionKey: `${currentAgentId ?? ""}\0${state.sessionKey}`,
      session: selectedSession,
    });
    const gatewaySnapshot = this.context.gateway.snapshot;
    const mainKey = resolveUiConfiguredMainKey({
      agentsList: this.context.agents.state.agentsList,
      hello: gatewaySnapshot.hello,
    });
    const placementComposer = this.placementComposerPresentation(
      selectedSession,
      placementStartup !== null,
    );
    const restartRecoveryTombstoned = selectedSession?.restartRecoveryStatus === "tombstoned";
    const multiIdentity = this.hasMultipleIdentities();
    const catalogReason = this.catalogComposerReason(catalogKey);
    const catalogDisabledReason = catalogReason?.text ?? null;
    const { closePanelSlot, openPanelSlot, sessionWorkspace } = createChatPaneRails({
      state,
      sidebarLayout,
      presentation: this.sessionPresentation,
      visibleLayout: this.usesMobileHost ? this.presentSidebarLayout(sidebarLayout) : undefined,
      presentationId: this.presentationId,
      sessionTitle: this.resolveHeaderSessionTitle(selectedSession),
      paneLabel: this.paneLabel,
      presented: this.presented,
      gatewaySnapshot,
      setObserverVisibility: this.setSessionObserverVisibility,
      updateSidebarLayout: (layout) => this.commitSidebarLayout(layout),
      onOpenPanel: this.onSidebarPanelOpened,
    });
    const gatewayScope = gatewayPresentationScope(this.context.gateway);
    const selfUser = resolveCurrentSelfUser({
      snapshotUser:
        gatewaySnapshot.selfUser === undefined
          ? (gatewayScope.displayUser ?? undefined)
          : gatewaySnapshot.selfUser,
      presenceEntries: readPresenceEntries(this.presence.snapshot),
      presenceInstanceId: gatewaySnapshot.client?.instanceId,
    });
    const selfProfileId = selfUser?.identity?.type === "profile" ? selfUser.identity.id : null;
    const userPresentation = {
      userId: selfProfileId ?? this.presentationUserId,
      userName: selfUser?.name ?? state.userName,
      userAvatar: selfUser?.avatarUrl ?? state.userAvatar,
      channelAvatar: selectedSession ?? undefined,
    };
    this.presentationUserId = userPresentation.userId;
    const projectionRunId = resolveChatProjectionRunId({
      localRunId: state.chatRunId,
      activeRunIds: selectedSession?.activeRunIds,
      queue: state.chatQueue,
    });
    const historyHasMore = catalogKey
      ? Boolean(this.history.catalogCursor)
      : state.chatHistoryPagination.hasMore;
    const sessionActionCallbacks = createChatPaneSessionActionCallbacks({
      getSnapshot: () => this.context.gateway.snapshot,
      state,
      sessionParticipationBlocked,
      onDenied: (reason) => this.publishHeaderError(reason),
      onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
      onRewind: (entryId) => this.rewindToMessage(entryId),
      onFork: (entryId) => this.forkFromMessage(entryId),
    });
    const setReply = (target: ChatProps["replyTarget"]) => {
      state.chatReplyTarget = target;
      state.handleChatDraftChange(state.chatMessage);
    };
    const replyMessageAccess = this.currentReplyMessageAccess(state.sessionKey);
    const composerControls = catalogKey
      ? undefined
      : renderChatPaneComposerControls({
          state,
          selectedSession,
          agentDefaultModel,
          agentDefaultPermissionMode: selectedAgent?.defaultPermissionMode,
          modelAccess: mutationAccess.model,
          effortAccess: mutationAccess.effort,
          contextWindowAccess: mutationAccess.contextWindow,
          permissionAccess: mutationAccess.permission,
          canSelectFull: hasOperatorAdminAccess(gatewaySnapshot.hello?.auth ?? null),
          onModelSetup: () => this.context.navigate("model-setup"),
          onProviderSettings: (provider) =>
            navigateToModelProvider(this.context, currentAgentId, provider),
          onModelAccounts: () => this.context.navigate("profile"),
        });
    const messages = catalog ? this.history.catalogMessages : state.chatMessages;
    const publicationScope = this.captureConnectionScope();
    const readPublicationRow = () => {
      const row = selectedChatSessionRow(state);
      return (
        row && {
          ...row,
          agentId: row.agentId ?? resolveChatAgentId(state) ?? undefined,
          archived: this.isCurrentSessionArchived(state),
        }
      );
    };
    synchronizeChatPanePublication({
      holder: this.publication,
      publications: this.context.sessions.githubPublication,
      gatewaySnapshot,
      readRow: readPublicationRow,
      isScopeCurrent: publicationScope
        ? () => this.isConnectionScopeCurrent(publicationScope)
        : undefined,
      isPresented: () => this.presented,
      participationBlocked: sessionParticipationBlocked,
      runActive: hasAbortableSessionRun(state),
      workspaceConflict: Boolean(workspaceConflict),
    });
    const sessionDisabledBanner = this.sessionDisabledBanner({
      catalogDisabledReason,
      modelSetupRequired,
      restartRecoveryTombstoned,
      selectedSessionArchived,
      selectedSessionId: selectedSession?.sessionId?.trim() || undefined,
      selectedSession,
      sessionKey: state.sessionKey,
      unarchiveAccess: mutationAccess.unarchive,
    });
    const initialHistoryUnavailable = !catalogKey && isInitialChatHistoryUnavailable(state);
    const presence = this.presence.snapshot;
    const composerSessionKey = state.sessionKey;
    const composerConnected = state.connected;
    const catalogCanContinue = this.history.catalogSession?.canContinue === true;
    const composerPendingReason = state.connected ? null : pendingReason;
    const auth = gatewaySnapshot.hello?.auth ?? null;
    const hasWriteScope = hasOperatorWriteAccess(auth);
    const composerAccess =
      hasWriteScope ||
      (!catalog &&
        readSessionMethodScopeAccess(auth, {
          method: "chat.send",
          requiredScope: "operator.write",
          sessionScope: true,
          session: selectedSession,
        }).allowed);
    const suggestionViewer =
      multiIdentity &&
      !selectedSessionArchived &&
      hasWriteScope &&
      selectedSession?.visibility === "suggest" &&
      selectedSession.sharingRole === "viewer" &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.add") === true &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.list") === true;
    const nativeConversation = !catalog && !suggestionViewer;
    // Placement progress explains its gate; other gates need a reason or a banner.
    const disabledReason = nativeConversation
      ? (selectedSession?.sendDisabledReason ??
        (sessionParticipationBlocked ? t("chat.sessionSharing.readOnlyNotice") : null))
      : null;
    const available =
      !selectedSession?.providerReview &&
      sessionDisabledBanner?.kind !== "composer-replacement" &&
      (catalog
        ? catalogCanContinue
        : !disabledReason &&
          !(
            selectedSessionArchived ||
            selectedSession?.restartRecoveryStatus === "tombstoned" ||
            placementComposer.blocksSend
          ));
    const canWriteProgressCard = composerConnected && !sessionParticipationBlocked && hasWriteScope;
    const typingEnabled =
      multiIdentity &&
      hasWriteScope &&
      !catalog &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.typing") === true &&
      hasSessionPresenceViewers(
        presence,
        gatewaySnapshot.selfUser,
        gatewaySnapshot.client?.instanceId,
        composerSessionKey,
      );
    const composerAvailability = {
      canCompose: composerAccess && available,
      canSend: composerAccess && available,
      modelRequiredReason: catalog || suggestionViewer ? undefined : requiredReason,
      disabledReason:
        catalogDisabledReason ??
        (!composerAccess ? t("chat.sessionSharing.scopeReadOnlyNotice") : null) ??
        disabledReason ??
        placementComposer.busyMessage ??
        (placementComposer.state.kind === "failed" && !placementComposer.state.recoveryAction
          ? placementComposer.failedUnavailableMessage
          : null) ??
        // Offline sending stays available for the outbox; this band explains pending recovery.
        composerPendingReason,
      disabledReasonTone:
        !composerAccess ||
        disabledReason ||
        placementComposer.busyMessage ||
        (sessionParticipationBlocked && !suggestionViewer)
          ? ("info" as const)
          : ("danger" as const),
      disabledReasonBusy: placementComposer.busyMessage !== null,
      disabledBanner:
        sessionDisabledBanner ?? placementComposer.disabledBanner ?? modelUnavailableBanner,
      ...chatSubmitState(state, initialHistoryUnavailable, nativeConversation),
    };
    const mentionsUnsupported = !nativeConversation || selectedSession?.incognito || !selfProfileId;
    const conversationAttention = this.projectConversationAttention(
      state,
      currentAgentId,
      !catalogKey && !sessionParticipationBlocked,
    );
    const detailsProgressRefresh =
      canWriteProgressCard &&
      composerAvailability.canSend &&
      nativeConversation &&
      this.detailsProgressCardPresentation
        ? this.captureProgressCardRefreshAction()
        : undefined;
    const props: ChatProps = {
      canDismissPendingInputs: canDismissChatPendingInputs(mutationAccess, selectedSession, {
        nativeConversation,
        participationBlocked: sessionParticipationBlocked,
      }),
      applicationContext: this.context,
      registerBrowserAnnotationFocus: this.registerBrowserAnnotationFocus,
      transcript: this.transcript,
      onHistorySentinelRef: this.registerHistorySentinel,
      onTranscriptAnnouncementRef: this.registerTranscriptAnnouncement,
      onComposerShellRef: this.registerComposerShell,
      onComposerFloatRef: this.registerComposerFloat,
      onActivityPillsLayout: this.onActivityPillsLayout,
      onScrollPortRef: this.mobileScrollFades.register,
      paneId: this.presentationId,
      sessionKey: state.sessionKey,
      announceTranscript: this.active && this.presented,
      autoExpandToolCalls: state.chatVerboseLevel === "full",
      showThinking: state.settings.chatShowThinking,
      showToolCalls: state.settings.chatShowToolCalls,
      persistCommentary: state.settings.chatPersistCommentary !== false,
      // Recovery can temporarily withhold the first turn after history loaded empty.
      // Keep its pane loading until startup can display the retained message again.
      loading: catalogKey
        ? this.history.catalogLoading
        : (!state.connected && !state.currentSessionId) ||
          state.chatLoading ||
          (!runActive && pendingReason !== null && placementStartup === null),
      routeLoadingSkeleton: this.routeLoadingSkeleton && initialHistoryUnavailable,
      sending:
        state.chatSending ||
        this.sessionCreation.recovering ||
        this.collaboration.addOperation !== undefined,
      placementStartup: placementStartup ?? placementComposer.startup,
      guestWelcome: this.context.guestWelcome,
      onRetrySessionPlacementStartup: placementStartup?.retryable
        ? this.retrySessionPlacementStartup
        : undefined,
      onDiscardSessionPlacementStartup: placementStartup?.initialTurn
        ? this.discardSessionPlacementStartup
        : undefined,
      canAbort: sessionParticipationBlocked ? false : hasAbortableSessionRun(state),
      runActive,
      runStatus: state.chatRunStatus,
      startupStatus: activeChatRunStartupStatus(state.chatRunStartup),
      awaitingActivity:
        state.chatRunStartup == null &&
        !(state.chatRunId
          ? state.knownAgentRunIds.has(state.chatRunId)
          : selectedSession?.activeRunIds?.some((runId) => state.knownAgentRunIds.has(runId))),
      environmentStartStatus:
        placement?.state === "provisioning" ? placement.startStatus : undefined,
      waitingApproval: state.waitingApprovalStatuses.size > 0,
      compactionStatus: state.compactionStatus,
      fallbackStatus: state.fallbackStatus,
      providerPolicyNotice: catalogKey ? null : state.providerPolicyNotice,
      readProviderReview,
      progressCard: progressPresentation?.card ?? null,
      progressCardIdentity: progressPresentation?.identity,
      progressCardLifetime: progressPresentation?.lifetime,
      gatewayScope,
      progressCardInitialLoading: this.progressCardInitialLoading,
      progressCardRefresh: progressPresentation ? detailsProgressRefresh : undefined,
      collapseTaskProgress: state.settings.chatCollapseTaskProgress === true,
      ...this.captureProgressCardActions(canWriteProgressCard),
      readingHistory: state.chatReadingHistory,
      onProgressManipulate: () => {
        lockChatScroll(state);
        this.transcript.cancelScroll();
      },
      onDismissProgressCard: progressPresentation
        ? this.hideProgressCard.bind(this, progressPresentation)
        : undefined,
      ...conversationAttention,
      asyncQuestionStorage: nativeConversation
        ? this.chatState.composerPersistence.durableScope
        : null,
      ...createChatQuestionActions({
        state,
        questionState: this.questionPromptState,
        canSend: composerAvailability.canSend && nativeConversation && state.connected,
        isCurrent: () => this.state === state,
      }),
      historyPagination:
        historyHasMore || this.history.loadingOlder
          ? {
              hasMore: historyHasMore,
              loading:
                this.history.loadingOlder ||
                (catalogKey ? this.history.catalogLoading : state.chatLoading),
              onShowEarlier: () => void this.loadOlderMessages(),
            }
          : undefined,
      messages,
      toolMessages: catalog ? emptyTranscriptItems : state.chatToolMessages,
      guardianNotices: catalog ? emptyTranscriptItems : state.guardianNotices,
      streamSegments: catalog ? emptyTranscriptItems : state.chatStreamSegments,
      get stream() {
        return catalog ? null : state.chatStream;
      },
      reasoning: catalog ? null : state.chatReasoning,
      streamStartedAt: catalog ? null : state.chatStreamStartedAt,
      runId: catalog ? null : projectionRunId,
      runUsageById: catalog ? undefined : state.chatRunUsageById,
      assistantAvatarUrl: resolveChatAvatarUrl(state),
      sendShortcut: state.settings.chatSendShortcut,
      followUpMode: state.chatFollowUpMode,
      draft: state.chatMessage,
      draftSource: this.chatState.composerDraft,
      composerPredictions: {
        enabled: this.context.config.current.composerPredictionsEnabled === true,
        active: !catalogKey && this.active && this.presented,
        gateway: this.context.gateway,
      },
      registerHumanMentionAccess: this.registerHumanMentionAccess,
      mentions: state.chatMentions,
      getMentions: () => state.chatMentions ?? [],
      mentionsUnsupported,
      mentionDirectory:
        state.connected && state.client && !mentionsUnsupported && !sessionParticipationBlocked
          ? {
              client: state.client,
              // Separately hydrated session-list metadata must not cancel an active query.
              ownerKey: JSON.stringify([state.connectionEpoch, selfProfileId]),
              params: { sessionKey: state.sessionKey, agentId: currentAgentId },
            }
          : undefined,
      modelCatalog: state.chatModelCatalog,
      modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
      queue: state.chatQueue,
      getQueue: () => state.chatQueue,
      realtimeTalkActive: state.realtimeTalk.snapshot.realtimeTalkActive,
      realtimeTalkStatus: state.realtimeTalk.snapshot.realtimeTalkStatus,
      realtimeTalkDetail: state.realtimeTalk.snapshot.realtimeTalkDetail,
      realtimeTalkInputNotice: state.realtimeTalk.snapshot.realtimeTalkInputNotice,
      realtimeTalkInputLevel: state.realtimeTalk.snapshot.realtimeTalkInputLevel,
      realtimeTalkConversation: state.realtimeTalk.snapshot.realtimeTalkConversationState.entries,
      realtimeTalkVideoStream: state.realtimeTalk.snapshot.realtimeTalkVideoStream,
      realtimeTalkCameraDevices: state.realtimeTalk.snapshot.realtimeTalkCameraDevices,
      realtimeTalkVideoCapable: state.realtimeTalk.snapshot.realtimeTalkVideoCapable,
      realtimeTalkVideoPending: state.realtimeTalk.snapshot.realtimeTalkVideoPending,
      realtimeTalkCameraError: state.realtimeTalk.snapshot.realtimeTalkCameraError,
      connected: state.connected,
      offline: gatewaySnapshot.offlineStable,
      gatewayClient: state.client,
      composerHoldToRecord: state.settings.composerHoldToRecord,
      realtimeTalkInputDeviceId: state.settings.realtimeTalkInputDeviceId,
      onComposerHoldToRecordChange: (enabled) => {
        state.settings = patchSettings({ composerHoldToRecord: enabled });
      },
      onOpenTalkSettings: () => this.context.navigate("talk"),
      onOpenDictationSettings: () => this.context.navigate("model-setup"),
      suggestionComposer: suggestionViewer,
      typingActors: multiIdentity ? this.collaboration.typingViews : [],
      typingOverflow: multiIdentity ? this.collaboration.typingOverflow : undefined,
      onTypingChange: typingEnabled
        ? (typing, preview, cursor) => this.sendTypingState(typing, preview, cursor)
        : undefined,
      ...composerAvailability,
      disabledReasonAction: catalogReason?.action,
      modelSetupRequired:
        modelSetupRequired && !selectedSessionArchived && !restartRecoveryTombstoned,
      onModelSetup: () => this.context.navigate("model-setup"),
      error: providerPaused ? null : state.lastError,
      diskSpace: placementComposer.diskSpace,
      workerRuntimeInstall: placementComposer.workerRuntimeInstall,
      runError:
        catalogKey || providerPaused ? null : (state.chatRunError ?? placementComposer.runError),
      workspaceConflict: visibleWorkspaceConflict,
      onDismissWorkspaceConflict:
        visibleWorkspaceConflict && selectedSession
          ? () => {
              this.workspaceConflicts.dismissedRefs = new Map(
                this.workspaceConflicts.dismissedRefs,
              ).set(selectedSession.key, visibleWorkspaceConflict.stagedResultRef);
            }
          : undefined,
      sessions: state.sessionsResult,
      ...this.transcriptSessionProps(selectedSession),
      toolOverrides: selectedSession?.toolOverrides,
      capabilityMenu: catalogKey
        ? undefined
        : this.composerCapabilities.props(this.context, state, selectedSession, currentAgentId),
      ...childRoster,
      sessionHost: {
        assistantAgentId: state.assistantAgentId,
        agentsList: state.agentsList,
        hello: state.hello,
      },
      contextGateway: this.context.gateway,
      onOpenContext: this.openContextPanel,
      operatorAuth: state.hello?.auth ?? null,
      providerUsage: {
        basePath: state.basePath,
        modelAuthStatusResult: state.modelAuthStatusResult,
      },
      composerControls: composerControls?.composerControls,
      permissionPicker: composerControls?.permissionPicker,
      ...this.suggestionChatProps(state.connected, selectedSessionArchived, multiIdentity),
      messageReactions: this.collaboration.reactions,
      onReact: this.canReactToCurrentSession() ? this.handleMessageReaction : undefined,
      pullRequests: this.visibleSessionPullRequests,
      pullRequestsGateway: this.context.gateway,
      pullRequestsSessionId: selectedSession?.sessionId,
      pullRequestsBranch: this.sessionPullRequestsBranch,
      pullRequestsBranchDismissed: this.sessionPullRequestsBranchDismissed,
      pullRequestsStatus: this.sessionPullRequestsStatus,
      onDismissPullRequest: this.dismissSessionPullRequest,
      onDismissPullRequestsBranch: this.dismissSessionPullRequestsBranch,

      onOpenSessionDiff: sessionWorkspace.onOpenDiff,
      githubPublication: this.publication.binding?.view(),
      onOpenWorkspaceFile: (target) => void openSessionWorkspaceFile(state, target),
      onOpenSessionLink: (target) => navigateMarkdownSession(this.context, target),
      onNavigate: (routeId, options) => this.context.navigate(routeId, options),
      onRefresh: this.refreshHistory,
      onChatScroll: (event) => this.handleTranscriptScroll(event),
      onHistoryIntent: (event) => this.handleTranscriptHistoryIntent(event),
      // Lazy SVG sizing can resize a committed row; re-enter the scroll owner
      // so an active follow lock stays pinned to the latest message.
      onAssistantAttachmentLoaded: () => scheduleChatScroll(state),
      getDraft: () => state.chatMessage,
      mediaOwner: state,
      onHistoryKeydown: state.handleChatInputHistoryKey,
      onSlashIntent: () => refreshChatCommands(state),
      onSlashCommand: nativeConversation
        ? (command) => void state.handleSendChat(command)
        : undefined,
      showNewMessages: state.chatNewMessagesBelow,
      onScrollToBottom: state.scrollToBottom,
      ...this.chatState.attachmentInputProps(state),
      cameraActive: this.conversationPresented,
      onRemoveAttachment: this.removeBrowserAnnotation,
      ...createChatPaneSendActions(state, {
        canSend: composerAvailability.canSend,
        modelRequiredReason: composerAvailability.modelRequiredReason,
        continueSession: catalogKey ? () => this.continueCatalogSession(catalogKey) : undefined,
        addSuggestion: suggestionViewer ? () => this.addCurrentSessionSuggestion() : undefined,
      }),
      ...createChatPaneRunRecoveryActions(state, {
        canSend: composerAvailability.canSend && !catalogKey && !suggestionViewer,
        isCurrent: () =>
          this.state === state && this.connectionGeneration === selectionConnectionGeneration,
        latestFailedRunId: () =>
          chatFailureRunId(state.chatRunError, selectedChatSessionRow(state)),
      }),
      onUseSystemDefaultMicrophone:
        state.realtimeTalk.snapshot.realtimeTalkUseSystemDefault ?? undefined,
      onToggleRealtimeTalk: () => (providerPaused ? undefined : void state.toggleRealtimeTalk()),
      onToggleRealtimeCamera: () => void state.toggleRealtimeTalkCamera(),
      onSwitchRealtimeCamera: () => void state.switchRealtimeTalkCamera(),
      onDismissError: () => dismissChatError(state),
      onDismissRealtimeTalkError: () => dismissRealtimeTalkError(state),
      onDismissRealtimeTalkInputNotice: () =>
        state.realtimeTalk.update({ realtimeTalkInputNotice: null }),
      ...sessionActionCallbacks,
      onQueueRemove: state.removeQueuedMessage,
      onQueueRetry: providerPaused ? undefined : (id) => void state.retryQueuedChatMessage(id),
      onQueueSteer:
        sessionParticipationBlocked || providerPaused
          ? undefined
          : (id) => void state.steerQueuedChatMessage(id),
      onQueueMove: sessionParticipationBlocked ? undefined : state.moveQueuedChatMessage,
      queuedEdit: createChatPaneQueuedEditProps(state, sessionParticipationBlocked),
      goalRecovery: chatGoalRecovery(state),
      onGoalAction: (goalId, action) => void mutateChatGoal(state, { goalId, action }),
      goalDraftMode: state.chatGoalDraftMode ?? null,
      currentSessionId: state.currentSessionId,
      onGoalDraftModeChange: (mode) => {
        state.chatGoalDraftMode = mode;
        state.handleChatDraftChange(state.chatMessage);
      },
      onGoalSubmit: nativeConversation
        ? (draft, submissionAction) => submitChatGoalDraft(state, draft, submissionAction)
        : undefined,
      onCompanionStageAttachment: (attachment, sessionKey) =>
        this.state === state &&
        this.connectionGeneration === selectionConnectionGeneration &&
        resolveChatAgentId(state) === currentAgentId &&
        this.stageSessionCompanionAttachment(attachment, sessionKey),
      replyTarget: state.chatReplyTarget ?? null,
      onClearReply: () => setReply(null),
      onSetReply: sessionDisabledBanner ? undefined : setReply,
      replyMessageAccess: catalogKey || selectedSessionArchived ? undefined : replyMessageAccess,
      onRewindMessage: selectedSessionArchived ? undefined : sessionActionCallbacks.onRewindMessage,
      agentsList: state.agentsList,
      currentAgentId,
      fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
      loadFullAssistantMessage: createSidebarFullMessageLoader(state, this.context.gateway),
      onSessionSelect: (next) => this.onPaneSessionChange?.(this.paneId, next),
      canvasPluginSurfaceUrl: state.canvasPluginSurfaceUrl,
      boardProvider: board.provider,
      widgetLayout: createChatWidgetLayout(state.chatMessagesBySession, state, {
        sessionKey: state.sessionKey,
        ...scopedAgentParamsForSession(state, state.sessionKey),
      }),
      onOpenSidebar: state.handleOpenSidebar,
      onRequestOpenImage: state.beginImageOpen,
      onOpenImage: state.handleOpenImage,
      assistantName: state.assistantName,
      assistantAvatar: state.assistantAvatar,
      senderAgentAvatars: state.senderAgentAvatars,
      mainKey,
      ...userPresentation,
      personActivity: personActivityRouting(this.context),
      ...chatPaneResourceProps(state, this.context),
      chatMessageMaxWidth: state.settings.chatMessageMaxWidth,
      chatBubbleMode: isChatBubbleMode(
        state.settings,
        state.sessionKey,
        this.context.config.current.chatBubblesEnabled,
        mainKey,
      ),
      branding: this.context?.theme.branding,
    };
    return {
      providerReviewSource: { state, canWrite: canWriteProgressCard && !selectedSessionArchived },
      capabilityDialogs: catalogKey
        ? undefined
        : {
            read: () => this.composerCapabilities.dialogView(this.context, state, selectedSession),
          },
      layout: this.renderChatPaneLayout({
        state,
        selectedSession,
        currentAgentId,
        board,
        sidebarLayout,
        sessionWorkspace,
        chatProps: props,
        detailsActions: {
          ...this.captureProgressCardActions(canWriteProgressCard),
          progressCardRefresh: detailsProgressRefresh,
        },
        observerDigest,
        observerRunId,
        catalog,
        agentWorkspace: selectedAgent?.workspace,
        workspaceGit: selectedAgent?.workspaceGit === true,
        openPanelSlot,
        closePanelSlot,
      }),
    };
  }
}
