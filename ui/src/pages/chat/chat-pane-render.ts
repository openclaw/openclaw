import type { ProgressCard } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { patchSettings } from "../../app/settings.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../../app/user-profile.ts";
import {
  markdownSessionPublicOrigin,
  navigateMarkdownSession,
} from "../../components/markdown-session-links.ts";
import { personActivityRouting } from "../../components/person-activity-link.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { t } from "../../i18n/index.ts";
import { isModelIndependentChatCommand } from "../../lib/chat/commands.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  pickFreshestObserverDigest,
  projectSessionObserverDigest,
  resolveChatPaneObserverRunId,
} from "../../lib/observer-digest.ts";
import { hasSessionPresenceViewers } from "../../lib/presence-users.ts";
import { projectsForGateway } from "../../lib/projects.ts";
import { GitHubPublicationController } from "../../lib/sessions/github-publication-controller.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { chatGoalRecovery, mutateChatGoal, submitChatGoalDraft } from "./chat-goals.ts";
import { clearChatHistory } from "./chat-history-actions.ts";
import { isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import { resolveChatMessageAccess } from "./chat-message-access.ts";
import { resolveChatModelSetup } from "./chat-model-setup.ts";
import { ChatPaneLayoutRender } from "./chat-pane-layout-render.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import {
  createChatPaneQueuedEditProps,
  createChatPaneSessionActionCallbacks,
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { resolveSidebarLayoutForBoard } from "./chat-pane-sidebar-layout.ts";
import {
  dismissChatError,
  initialHistorySubmitState,
  resolveAssistantAttachmentAuthToken,
  resolveChatArtifactDownload,
  resolveChatPaneFollowUpMode,
} from "./chat-pane-state.ts";
import { ChatProviderReviewController } from "./chat-provider-review-controller.ts";
import { createChatQuestionActions } from "./chat-question-actions.ts";
import { dismissRealtimeTalkError } from "./chat-realtime.ts";
import { activeChatRunStartupStatus } from "./chat-run-startup.ts";
import { chatSendHoldReason } from "./chat-send-support.ts";
import { refreshChatCommands } from "./chat-state-refresh.ts";
import {
  resolveChatAgentId,
  resolveChatAvatarUrl,
  selectedChatSessionRow,
} from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import {
  openSessionWorkspaceFile,
  revealSessionWorkspaceFile,
} from "./components/chat-session-workspace.ts";
import { resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";
import { hasAbortableSessionRun, hasDirectSessionRun } from "./run-lifecycle.ts";
import { lockChatScroll, scheduleChatScroll } from "./scroll.ts";
import { resolveChatProjectionRunId } from "./tool-stream-status.ts";
import { workspaceResultConflictFromPlacement } from "./workspace-conflict.ts";

export class ChatPane extends ChatPaneLayoutRender {
  private readonly providerReview = new ChatProviderReviewController(
    this,
    () => this.state ?? undefined,
  );
  private presentationUserId: string | null = null;
  // Stable absent inputs let catalog renders reuse the transcript cache.
  private readonly emptyTranscriptItems: [] = [];

  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const selectedSession = selectedChatSessionRow(state);
    const providerPaused = Boolean(selectedSession?.providerReview);
    const readTarget = this.resolveChatReadTarget();
    const progressPresentation = this.progressCardPresentation;
    const selectedSessionArchived = this.isCurrentSessionArchived(state);
    const mutationAccess = readChatPaneMutationAccess(
      this.context.gateway.snapshot,
      state.sessionKey,
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
      this.dismissedWorkspaceConflictRefs.get(selectedSession?.key ?? state.sessionKey) !==
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
    const { catalogKey, chatProps } = resolveChatMessageAccess(state);
    const overlays = this.context?.overlays;
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
      catalog: catalogKey !== null,
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
    const sendHoldReason = chatSendHoldReason(state, state.sessionKey, placementStartup !== null);
    const runActive = hasDirectSessionRun(state);
    const sessionParticipationBlocked = this.sessionParticipationTracker.resolve({
      catalog: catalogKey !== null,
      listLoading: state.sessionsLoading,
      sessionKey: `${currentAgentId ?? ""}\0${state.sessionKey}`,
      session: selectedSession,
    });
    const gatewaySnapshot = this.context.gateway.snapshot;
    const placementComposer = this.placementComposerPresentation(
      selectedSession,
      placementStartup !== null,
    );
    const canDismissProgressCard =
      state.connected &&
      !sessionParticipationBlocked &&
      hasOperatorWriteAccess(gatewaySnapshot.hello?.auth ?? null);
    this.providerReview.sync(canDismissProgressCard && !selectedSessionArchived);
    const onDismissProgressCard = canDismissProgressCard
      ? (card: ProgressCard) =>
          void this.progressCard
            .dismiss(card)
            .catch(() => showToast({ message: t("sessionProgressCard.dismissFailed") }))
      : undefined;
    const restartRecoveryTombstoned = selectedSession?.restartRecoveryStatus === "tombstoned";
    const multiIdentity = this.hasMultipleIdentities();
    const suggestionViewer =
      multiIdentity &&
      !selectedSessionArchived &&
      hasOperatorWriteAccess(gatewaySnapshot.hello?.auth ?? null) &&
      selectedSession?.visibility === "suggest" &&
      selectedSession.sharingRole === "viewer" &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.add") === true &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.list") === true;
    // Placement progress explains this gate; other gates need a reason or sessionDisabledBanner.
    const disabledReason =
      sessionParticipationBlocked && !suggestionViewer
        ? t("chat.sessionSharing.readOnlyNotice")
        : null;
    const modelRequiredReason = catalogKey || suggestionViewer ? undefined : requiredReason;
    const typingEnabled =
      multiIdentity &&
      hasOperatorWriteAccess(gatewaySnapshot.hello?.auth ?? null) &&
      !catalogKey &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.typing") === true &&
      hasSessionPresenceViewers(
        this.presencePayload,
        gatewaySnapshot.selfUser,
        gatewaySnapshot.client?.instanceId,
        state.sessionKey,
      );
    // Avoid flashing view-only while metadata loads; failed lookups still explain the gate.
    const catalogDisabledReason =
      catalogKey && !this.catalogLoading && this.catalogSession?.canContinue !== true
        ? this.catalogHost?.kind === "node"
          ? t("chat.catalog.remoteViewOnly")
          : t("chat.catalog.unsupportedViewOnly")
        : null;
    const { backgroundTasks, closePanelSlot, openPanelSlot, sessionWorkspace } =
      createChatPaneRails({
        state,
        sidebarLayout,
        presentationId: this.presentationId,
        presented: this.presented,
        gatewaySnapshot,
        setObserverVisibility: this.setSessionObserverVisibility,
        updateSidebarLayout: (layout) => this.commitSidebarLayout(layout),
      });
    const selfUser = resolveCurrentSelfUser({
      snapshotUser: gatewaySnapshot.selfUser,
      presenceEntries: readPresenceEntries(this.presencePayload),
      presenceInstanceId: gatewaySnapshot.client?.instanceId,
    });
    if (selfUser?.identity?.type === "profile") {
      this.presentationUserId = selfUser.identity.id;
    }
    const projectionRunId = resolveChatProjectionRunId({
      localRunId: state.chatRunId,
      activeRunIds: selectedSession?.activeRunIds,
      queue: state.chatQueue,
    });
    const historyHasMore = catalogKey
      ? Boolean(this.catalogCursor)
      : state.chatHistoryPagination.hasMore;
    const fetchLinkFavicon = resolveChatLinkFaviconFetcher(state);
    const sessionActionCallbacks = createChatPaneSessionActionCallbacks({
      getSnapshot: () => this.context.gateway.snapshot,
      hasLocalRun: () => Boolean(state.chatRunId),
      sessionParticipationBlocked,
      onDenied: (reason) => this.publishHeaderError(reason),
      onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
      onRewind: (entryId) => this.rewindToMessage(entryId),
      onFork: (entryId) => this.forkFromMessage(entryId),
      onReset: () => void clearChatHistory(state),
    });
    const setReply: NonNullable<ChatProps["onSetReply"]> = (target) => {
      state.chatReplyTarget = target;
      state.requestUpdate?.();
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
          onModelAccounts: () => this.context.navigate("profile"),
        });
    const composerState = getChatComposerState(this.presentationId);
    const projectCatalog = projectsForGateway(this.context.gateway).snapshot;
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
    const publicationRow = readPublicationRow();
    if (
      !publicationScope ||
      !publicationRow ||
      !isGatewayMethodAdvertised(gatewaySnapshot, "sessions.github.publish")
    ) {
      this.githubPublication?.detach();
      this.githubPublication = null;
    } else {
      if (!this.githubPublication?.matches(publicationRow)) {
        this.githubPublication?.detach();
        this.githubPublication = this.context.sessions.githubPublication.attach(
          publicationRow,
          () => this.requestUpdate(),
          GitHubPublicationController,
        );
      }
      const publication = this.githubPublication;
      publication?.sync({
        canWrite:
          !selectedSessionArchived &&
          !sessionParticipationBlocked &&
          hasOperatorWriteAccess(gatewaySnapshot.hello?.auth ?? null),
        personalReady:
          !hasAbortableSessionRun(state) &&
          (!isCloudWorkerPlacementState(placement?.state) ||
            (Boolean(publicationRow.repositoryWorkspaceId) && placement?.state === "active")) &&
          !workspaceConflict,
        isPresented: () => this.presented,
        isCurrent: () => {
          const row = readPublicationRow();
          return (
            this.isConnectionScopeCurrent(publicationScope) &&
            row !== undefined &&
            publication?.matches(row)
          );
        },
      });
    }
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
    const composerAvailability = {
      canSend:
        !providerPaused &&
        sessionDisabledBanner?.kind !== "composer-replacement" &&
        (catalogKey
          ? this.catalogSession?.canContinue === true
          : !disabledReason &&
            !selectedSessionArchived &&
            !restartRecoveryTombstoned &&
            !placementComposer.blocksSend &&
            (!sendHoldReason || initialHistoryUnavailable)),
      ...initialHistorySubmitState(state, initialHistoryUnavailable),
      modelRequiredReason,
      disabledReason:
        catalogDisabledReason ??
        disabledReason ??
        placementComposer.busyMessage ??
        (placementComposer.state.kind === "failed" && !placementComposer.state.recoveryAction
          ? placementComposer.failedUnavailableMessage
          : null) ??
        (state.connected && (placementStartup || initialHistoryUnavailable)
          ? null
          : sendHoldReason),
      disabledReasonTone:
        placementComposer.busyMessage || (sessionParticipationBlocked && !suggestionViewer)
          ? ("info" as const)
          : ("danger" as const),
      disabledReasonBusy: placementComposer.busyMessage !== null,
      disabledBanner:
        sessionDisabledBanner ?? placementComposer.disabledBanner ?? modelUnavailableBanner,
    };
    const progressCardRefresh =
      canDismissProgressCard &&
      composerAvailability.canSend &&
      !catalogKey &&
      !suggestionViewer &&
      progressPresentation
        ? this.captureProgressCardRefreshAction()
        : undefined;
    const selfProfileId = selfUser?.identity?.type === "profile" ? selfUser.identity.id : null;
    const mentionsUnsupported = Boolean(
      catalogKey || suggestionViewer || selectedSession?.incognito || !selfProfileId,
    );
    const { gatewayQuestionPrompts, inlineApproval } = this.projectConversationAttention(
      state,
      currentAgentId,
      !catalogKey && !sessionParticipationBlocked,
    );
    const props: ChatProps = {
      transcript: this.transcript,
      paneId: this.presentationId,
      sessionKey: state.sessionKey,
      announceTranscript: this.active && this.presented,
      onSessionKeyChange: (next) => void this.onPaneSessionChange?.(this.paneId, next),
      thinkingLevel: state.chatThinkingLevel,
      autoExpandToolCalls: state.chatVerboseLevel === "full",
      showThinking: state.settings.chatShowThinking,
      showToolCalls: state.settings.chatShowToolCalls,
      persistCommentary: state.settings.chatPersistCommentary !== false,
      // Recovery can temporarily withhold the first turn after history loaded empty.
      // Keep its pane loading until startup can display the retained message again.
      loading: catalogKey
        ? this.catalogLoading
        : state.chatLoading || (!runActive && sendHoldReason !== null && placementStartup === null),
      routeLoadingSkeleton: this.routeLoadingSkeleton && initialHistoryUnavailable,
      sending:
        (placementStartup !== null && placementStartup.phase !== "failed") ||
        state.chatSending ||
        this.recoveringSession ||
        this.sessionSuggestionAddOperation !== undefined,
      placementStartup: placementStartup ?? placementComposer.startup,
      onRetrySessionPlacementStartup: placementStartup?.retryable
        ? () => this.context.placementStartup.retry(state.sessionKey)
        : undefined,
      canAbort: sessionParticipationBlocked ? false : hasAbortableSessionRun(state),
      runActive,
      runStatus: state.chatRunStatus,
      startupStatus: activeChatRunStartupStatus(state.chatRunStartup),
      waitingApproval: state.waitingApprovalStatuses.size > 0,
      compactionStatus: state.compactionStatus,
      fallbackStatus: state.fallbackStatus,
      providerPolicyNotice: catalogKey ? null : state.providerPolicyNotice,
      providerReviewNotice: this.providerReview.notice(),
      progressCard: progressPresentation?.card ?? null,
      progressCardIdentity: progressPresentation?.identity,
      progressCardLifetime: progressPresentation?.lifetime,
      gatewayScope: gatewayPresentationScope(this.context.gateway),
      progressCardInitialLoading: this.progressCardInitialLoading,
      progressCardRefresh,
      collapseTaskProgress: state.settings.chatCollapseTaskProgress === true,
      readingHistory: state.chatReadingHistory,
      onProgressManipulate: () => {
        lockChatScroll(state);
        this.transcript.cancelScroll();
      },
      onDismissProgressCard,
      gatewayQuestionPrompts,
      asyncQuestionStorage:
        !catalogKey && !suggestionViewer ? this.chatState.durableComposerScope : null,
      ...createChatQuestionActions({
        state,
        questionState: this.questionPromptState,
        canSend:
          composerAvailability.canSend && !catalogKey && !suggestionViewer && state.connected,
        isCurrent: () => this.state === state,
      }),
      messages: catalogKey ? this.catalogMessages : state.chatMessages,
      historyPagination:
        historyHasMore || this.loadingOlder
          ? {
              hasMore: historyHasMore,
              loading: this.loadingOlder || (catalogKey ? this.catalogLoading : state.chatLoading),
              onShowEarlier: () => void this.loadOlderMessages(),
            }
          : undefined,
      toolMessages: catalogKey ? this.emptyTranscriptItems : state.chatToolMessages,
      guardianNotices: catalogKey ? this.emptyTranscriptItems : state.guardianNotices,
      streamSegments: catalogKey ? this.emptyTranscriptItems : state.chatStreamSegments,
      stream: catalogKey ? null : state.chatStream,
      streamStartedAt: catalogKey ? null : state.chatStreamStartedAt,
      runId: catalogKey ? null : projectionRunId,
      runUsageById: catalogKey ? undefined : state.chatRunUsageById,
      assistantAvatarUrl: resolveChatAvatarUrl(state),
      sendShortcut: state.settings.chatSendShortcut,
      followUpMode: state.chatFollowUpMode,
      draft: state.chatMessage,
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
      queuedOutboxCount: state.chatQueue.filter((item) => !item.pendingRunId).length,
      realtimeTalkActive: state.realtimeTalkActive,
      realtimeTalkStatus: state.realtimeTalkStatus,
      realtimeTalkDetail: state.realtimeTalkDetail,
      realtimeTalkInputNotice: state.realtimeTalkInputNotice,
      realtimeTalkInputLevel: state.realtimeTalkInputLevel,
      realtimeTalkConversation: state.realtimeTalkConversation,
      realtimeTalkVideoStream: state.realtimeTalkVideoStream,
      realtimeTalkCameraDevices: state.realtimeTalkCameraDevices,
      realtimeTalkVideoCapable: state.realtimeTalkVideoCapable,
      realtimeTalkVideoPending: state.realtimeTalkVideoPending,
      realtimeTalkCameraError: state.realtimeTalkCameraError,
      realtimeTalkVoice: state.realtimeTalkVoice,
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
      typingActors: multiIdentity ? this.typingActorViews() : [],
      onTypingChange: typingEnabled
        ? (typing, preview) => this.sendTypingState(typing, preview)
        : undefined,
      ...composerAvailability,
      modelSetupRequired:
        modelSetupRequired && !selectedSessionArchived && !restartRecoveryTombstoned,
      onModelSetup: () => this.context.navigate("model-setup"),
      error: providerPaused ? null : state.lastError,
      diskSpace: placementComposer.diskSpace,
      runError:
        catalogKey || providerPaused ? null : (state.chatRunError ?? placementComposer.runError),
      inlineApproval,
      approvalBusy: overlays?.snapshot?.approvalBusy,
      approvalCanGrant: overlays?.snapshot?.approvalCanGrant ?? false,
      approvalErrors: overlays?.snapshot?.approvalErrors,
      onApprovalDecision:
        overlays && !sessionParticipationBlocked
          ? (approvalId, decision) =>
              overlays.decideApproval(decision, approvalId, inlineApproval ?? undefined)
          : undefined,
      workspaceConflict: visibleWorkspaceConflict,
      onDismissWorkspaceConflict:
        visibleWorkspaceConflict && selectedSession
          ? () => {
              this.dismissedWorkspaceConflictRefs.set(
                selectedSession.key,
                visibleWorkspaceConflict.stagedResultRef,
              );
              this.requestUpdate();
            }
          : undefined,
      sessions: state.sessionsResult,
      selectedSession: catalogKey ? undefined : selectedSession,
      toolOverrides: selectedSession?.toolOverrides,
      capabilityMenu: catalogKey
        ? undefined
        : this.composerCapabilities.props(
            this.context,
            state,
            selectedSession,
            currentAgentId,
            composerState.capabilityMenuView.startsWith("tools:"),
            composerState.capabilityMenuOpen &&
              (composerState.capabilityMenuView === "skills" ||
                composerState.capabilityMenuView.startsWith("library:")),
          ),
      swarm: readTarget ? { ...readTarget, sessions: this.swarmHydrator?.rows ?? [] } : undefined,
      sessionHost: {
        assistantAgentId: state.assistantAgentId,
        agentsList: state.agentsList,
        hello: state.hello,
      },
      providerUsage: {
        basePath: state.basePath,
        modelAuthStatusResult: state.modelAuthStatusResult,
      },
      composerControls: composerControls?.composerControls ?? nothing,
      permissionPicker: composerControls?.permissionPicker,
      backgroundTasks: catalogKey ? undefined : backgroundTasks,
      ...this.suggestionChatProps(state.connected, selectedSessionArchived, multiIdentity),
      pullRequests: this.visibleSessionPullRequests,
      // Until catalog success, a lowercase name may be a hidden/ambiguous alias.
      // Do not mint a checkout link that can prefetch the wrong repository.
      githubRepo: projectCatalog.result ? this.githubRepo : null,
      githubRepositories: projectCatalog.repositories,
      pullRequestsGateway: this.context.gateway,
      pullRequestsBranch: this.sessionPullRequestsBranch,
      pullRequestsStatus: this.sessionPullRequestsStatus,
      onOpenSessionDiff: sessionWorkspace.onOpenDiff,
      onDismissPullRequest: this.dismissSessionPullRequest,
      githubPublication: this.githubPublication?.view(),
      onOpenWorkspaceFile: (target) => openSessionWorkspaceFile(state, target),
      onOpenSessionLink: (target) => navigateMarkdownSession(this.context, target),
      onRevealWorkspaceFile: (path) => revealSessionWorkspaceFile(state, path),
      onRefresh: this.refreshHistory,
      onChatScroll: (event) => this.handleTranscriptScroll(event),
      onHistoryIntent: (event) => this.handleTranscriptHistoryIntent(event),
      // Lazy SVG sizing can resize a committed row; re-enter the scroll owner
      // so an active follow lock stays pinned to the latest message.
      onAssistantAttachmentLoaded: () => scheduleChatScroll(state),
      getDraft: () => state.chatMessage,
      onDraftChange: state.handleChatDraftChange,
      onRequestUpdate: state.requestUpdate,
      onHistoryKeydown: state.handleChatInputHistoryKey,
      onSlashIntent: () => refreshChatCommands(state),
      onSlashCommand:
        suggestionViewer || catalogKey
          ? undefined
          : (command) => void state.handleSendChat(command),
      showNewMessages: state.chatNewMessagesBelow,
      onScrollToBottom: state.scrollToBottom,
      ...this.chatState.attachmentInputProps(state),
      onRemoveAttachment: this.removeBrowserAnnotation,
      onSend: (followUpModeOverride, submissionAction) =>
        !composerAvailability.canSend ||
        (modelRequiredReason &&
          (state.chatAttachments.length > 0 || !isModelIndependentChatCommand(state.chatMessage)))
          ? undefined
          : catalogKey
            ? this.continueCatalogSession(catalogKey)
            : suggestionViewer
              ? this.addCurrentSessionSuggestion()
              : state.handleSendChat(
                  undefined,
                  followUpModeOverride ? { followUpMode: followUpModeOverride } : undefined,
                  submissionAction,
                ),
      onUseSystemDefaultMicrophone: state.realtimeTalkUseSystemDefault ?? undefined,
      onToggleRealtimeTalk: () => {
        if (!providerPaused) {
          void state.toggleRealtimeTalk();
        }
      },
      onSelectRealtimeVoice: (voice) => void state.selectRealtimeTalkVoice(voice),
      onToggleRealtimeCamera: () => void state.toggleRealtimeTalkCamera(),
      onSwitchRealtimeCamera: () => void state.switchRealtimeTalkCamera(),
      onDismissError: () => {
        dismissChatError(state as never);
        state.requestUpdate?.();
      },
      onDismissRealtimeTalkError: () => {
        dismissRealtimeTalkError(state as never);
        state.requestUpdate?.();
      },
      onDismissRealtimeTalkInputNotice: () => {
        state.realtimeTalkInputNotice = null;
        state.requestUpdate?.();
      },
      onAbort: sessionActionCallbacks.onAbort,
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
      onGoalSubmit:
        suggestionViewer || catalogKey
          ? undefined
          : (draft, submissionAction) => submitChatGoalDraft(state, draft, submissionAction),
      onCompanionPrefill: this.prefillSessionCompanionQuestion,
      replyTarget: state.chatReplyTarget ?? null,
      onClearReply: () => {
        state.chatReplyTarget = null;
        state.requestUpdate?.();
      },
      onSetReply: sessionDisabledBanner ? undefined : setReply,
      replyMessageAccess: catalogKey || selectedSessionArchived ? undefined : replyMessageAccess,
      onRewindMessage: selectedSessionArchived ? undefined : sessionActionCallbacks.onRewindMessage,
      onForkMessage: sessionActionCallbacks.onForkMessage,
      onClearHistory: sessionActionCallbacks.onClearHistory,
      agentsList: state.agentsList,
      currentAgentId,
      ...chatProps,
      onAgentChange: (agentId) =>
        void this.onPaneSessionChange?.(this.paneId, buildAgentMainSessionKey({ agentId })),
      onSessionSelect: (next) => this.onPaneSessionChange?.(this.paneId, next),
      canvasPluginSurfaceUrl: state.canvasPluginSurfaceUrl,
      boardProvider: board.provider,
      onOpenSidebar: state.handleOpenSidebar,
      onRequestOpenImage: state.beginImageOpen,
      onOpenImage: state.handleOpenImage,
      assistantName: state.assistantName,
      assistantAvatar: state.assistantAvatar,
      senderAgentAvatars: state.senderAgentAvatars,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: this.context.agents.state.agentsList,
        hello: this.context.gateway.snapshot.hello,
      }),
      userId: this.presentationUserId,
      userName: selfUser?.name ?? state.userName,
      userAvatar: selfUser?.avatarUrl ?? state.userAvatar,
      personActivity: personActivityRouting(this.context),
      mediaPolicyEpoch: state.mediaPolicyEpoch,
      connectionEpoch: state.connectionEpoch,
      embedSandboxMode: state.embedSandboxMode,
      allowExternalEmbedUrls: state.allowExternalEmbedUrls,
      fetchLinkFavicon,
      chatMessageMaxWidth: state.settings.chatMessageMaxWidth,
      branding: this.context?.theme.branding,
      assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state as never),
      resolveArtifactDownload: (params, signal) =>
        resolveChatArtifactDownload(state, params, signal),
      basePath: state.basePath,
      sessionPublicOrigin: markdownSessionPublicOrigin(this.context),
      resourceBasePath: state.resourceBasePath,
    };
    return html`${this.renderChatPaneLayout({
      state,
      selectedSession,
      currentAgentId,
      board,
      sidebarLayout,
      sessionWorkspace,
      backgroundTasks,
      chatProps: props,
      observerDigest,
      observerRunId,
      catalog: Boolean(catalogKey),
      agentWorkspace: selectedAgent?.workspace,
      workspaceGit: selectedAgent?.workspaceGit === true,
      openPanelSlot,
      closePanelSlot,
    })}${this.providerReview.dialog()}`;
  }
}
