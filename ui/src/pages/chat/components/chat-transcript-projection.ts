import type { JSX } from "@solidjs/web";
import { currentThemeBranding } from "../../../app/theme-branding.ts";
import { i18n } from "../../../i18n/index.ts";
import { channelSenderAvatarMemoKey } from "../../../lib/chat/channel-sender-avatar.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { localParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { assistantGroupCanOwnActiveRunStatus } from "../chat-assistant-reply.ts";
import { resolveTurnRecap, shouldRenderQueuedSendInThread } from "../chat-progress.ts";
import { projectChatReasoning } from "../chat-reasoning.ts";
import { projectSubagentStatus } from "../chat-subagent-wait.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import {
  buildCachedChatItems,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  setExpansionState,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { buildChatArchiveNotice } from "./chat-divider.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import type { StreamGroupOptions } from "./chat-message-stream-view.tsx";
import { projectRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";
import { getTranscriptState, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { projectTranscriptActivity } from "./chat-transcript-activity.ts";
import { latestTranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import {
  resolveTranscriptAvatarPlacement,
  resolveTranscriptParticipants,
} from "./chat-transcript-identity.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";
import {
  expandReplyTargetWork,
  projectTranscriptChain,
  projectTranscriptIndex,
  projectTranscriptRows,
} from "./chat-transcript-message-index.ts";
import { projectTranscriptRecovery } from "./chat-transcript-recovery.ts";
import {
  GuardedTranscriptItem,
  guardChatRenderItems,
  trackTranscriptRenderDependencies,
  transcriptReplyDependencies,
} from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";
import type { ChatTranscriptSession, TranscriptHeader } from "./chat-transcript-session.ts";
import { projectTranscriptWorkPreviews } from "./chat-transcript-work-previews.ts";
import { projectTurnVideoMessages } from "./chat-turn-video-gallery.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

type ChatRenderItem = SystemEventRenderItem;
const questionIndexes = createTranscriptMemo<NonNullable<StreamGroupOptions["questionPrompts"]>>();
const emptyQuestions: NonNullable<StreamGroupOptions["questionPrompts"]> = new Map();

export function projectChatTranscript(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
  search = getTranscriptState(props.paneId).search.snapshot,
) {
  const state = getTranscriptState(props.paneId);
  const { asyncQuestions, selectedSession: activeSession } = props;
  const { showOwnSenderName, replyPeople } = resolveTranscriptParticipants(props);
  const mediaPolicyKey = assistantMediaPolicyKey(activeSession, props.mediaPolicyEpoch);
  const { showReasoning, reasoning } = projectChatReasoning(props);
  const assistantAgentId = props.currentAgentId ?? props.fullMessageAgentId;
  const assistantAvatar = resolveAssistantDisplayAvatar({
    currentAgentId: assistantAgentId,
    agents: props.agents,
    assistantAvatar: props.assistantAvatar,
    assistantAvatarUrl: props.assistantAvatarUrl,
  });
  const assistantIdentity = {
    agentId: assistantAgentId,
    name: props.assistantName,
    avatar: assistantAvatar.avatar,
    textAvatar: assistantAvatar.textAvatar,
  };
  const locale = i18n.getLocale();
  const searchFiltering = search.open && Boolean(search.query.trim());
  const expandedAssistantMessages = transcript.expandedAssistantMessages;
  const recovery = projectTranscriptRecovery(expandedAssistantMessages, props);
  const subagents = projectSubagentStatus(props, searchFiltering);
  const chatItemsInput = {
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    archiveNotice: buildChatArchiveNotice(activeSession),
    runId: props.runId ?? null,
    compactionStatus: props.compactionStatus,
    locale,
    messages: props.messages,
    toolMessages: props.toolMessages,
    guardianNotices: props.guardianNotices,
    streamSegments: props.streamSegments,
    stream: props.stream ?? null,
    reasoning,
    showReasoning,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    initialTurnId: props.initialTurnId,
    pendingInputs: props.pendingInputs,
    workerSetupPending: ["requested", "provisioning", "syncing", "starting"].includes(
      activeSession?.placement?.state ?? "",
    ),
    workspaceSyncPendingRunIds:
      (activeSession?.placement?.state === "active" ||
        activeSession?.placement?.state === "draining") &&
      activeSession.placement.workspaceResultReconciling === true
        ? activeSession.activeRunIds
        : undefined,
    showToolCalls: props.showToolCalls,
    persistCommentary: props.persistCommentary,
    runWorking: Boolean(props.runWorking),
    runFinalizing: props.runFinalizing,
    runActive: Boolean(props.runActive),
    subagentWait: subagents.placedWait,
    questionPrompts: props.questionPrompts,
    loading: props.loading,
    replyPeople,
    replyLocalPerson: localParticipantIdentityKey(props.userId),
    searchOpen: search.open,
    searchQuery: search.query,
    messageRecovery:
      searchFiltering && props.loadFullAssistantMessage
        ? {
            messages: expandedAssistantMessages,
            revision: getExpansionStateVersion(expandedAssistantMessages),
            agentId: props.fullMessageAgentId,
          }
        : undefined,
  } satisfies Parameters<typeof buildCachedChatItems>[0];
  const chatItems = buildCachedChatItems(chatItemsInput);
  const { workingIndicator, activityRunId, activityGroupKey, runOutputTokens } =
    projectTranscriptActivity(chatItems, props);
  syncToolCardExpansionState(
    props.sessionKey,
    chatItems,
    Boolean(props.autoExpandToolCalls),
    searchFiltering || !props.showToolCalls,
  );
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const expandedUserMessages = getExpandedUserMessages(props.sessionKey);
  const transcriptChain = projectTranscriptChain(chatItems, {
    sessionKey: props.sessionKey,
    messages: props.messages,
    activeRunId: props.runActive || props.runWorking ? props.runId : null,
    runWorking: Boolean(props.runWorking),
    searchActive: searchFiltering,
    bubbleMode: props.chatBubbleMode === true,
    session: props.transcriptMetadata ?? activeSession,
  });
  const { collapsedItems, transcriptItems, continuations } = transcriptChain;
  const replyNavigationId = props.replyMessageAccess?.navigationId;
  if (replyNavigationId) {
    expandReplyTargetWork(transcriptItems, expandedToolCards, replyNavigationId);
  }
  const {
    messageRowKeysById,
    transcriptMessageKeys,
    loadedReplySources,
    positionIndex,
    rows,
    liveItem,
  } = projectTranscriptIndex(transcriptChain, expandedToolCards, props);
  const workPreviews = projectTranscriptWorkPreviews(transcriptChain.workGroups, {
    sessionKey: props.sessionKey,
    expanded: expandedToolCards,
    latestBrowserTabs: props.latestBrowserTabs,
    bubbleMode: props.chatBubbleMode,
  });
  const questionPrompts = props.questionPrompts
    ? questionIndexes(
        props.questionPrompts,
        [],
        () => new Map(props.questionPrompts!.map((prompt) => [prompt.id, prompt])),
      )
    : emptyQuestions;
  const toggleToolCardExpanded = (toolCardId: string, expanded?: boolean) => {
    setExpansionState(
      expandedToolCards,
      toolCardId,
      !(expanded ?? expandedToolCards.get(toolCardId) ?? false),
    );
  };
  const hasRealtimeTalkConversation = (props.realtimeTalkConversation?.length ?? 0) > 0;
  const hasTypingActors = (props.typingActors?.length ?? 0) > 0;
  const hasLiveContent = Boolean(subagents.wait || hasTypingActors || hasRealtimeTalkConversation);
  // An empty page is not an empty conversation. Keep the transcript mounted
  // while older history exists so the reader can request the next page.
  const isEmpty =
    transcriptItems.length === 0 &&
    !props.loading &&
    !hasLiveContent &&
    (!props.historyPagination?.hasMore || search.open);
  transcript.setContentReady(!props.loading);
  const { isDirectThread, avatarPlacement } = resolveTranscriptAvatarPlacement(props, chatItems);
  const showLoadingSkeleton = props.loading && transcriptItems.length === 0 && !hasTypingActors;
  const presented =
    typeof props.presented === "object" ? props.presented.isPresented() : (props.presented ?? true);
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;
  const resolvedRecap = resolveTurnRecap(state, {
    sessionKey: props.sessionKey,
    agentId: props.currentAgentId,
    gatewayClient: props.gatewayClient,
    indicator: workingIndicator,
    startingNewTurn: props.queue.some(
      (item) =>
        (item.sendState === "submitting" ||
          item.sendState === "sending" ||
          item.sendState === "waiting-model") &&
        shouldRenderQueuedSendInThread(item),
    ),
    activeRunId: props.runActive ? props.runId : undefined,
    row: activeSession,
    usageByRun: props.runUsageById,
  });
  // Default disclosure belongs only to a settled assistant at the transcript
  // tail; any newer visible row returns the prior answer to hover/tap behavior.
  const lastTranscriptItem =
    transcriptChain.live?.transcriptIndex === transcriptItems.length - 1
      ? liveItem
      : transcriptItems.at(-1);
  const tailStatusOwner =
    lastTranscriptItem?.kind === "agent-run-frame" &&
    lastTranscriptItem.outcome.kind === "completed" &&
    lastTranscriptItem.outcome.actionOwner !== null
      ? lastTranscriptItem
      : lastTranscriptItem?.kind === "group" &&
          assistantGroupCanOwnActiveRunStatus(lastTranscriptItem)
        ? lastTranscriptItem
        : null;
  // An unwatched background run must not inherit the visible turn's recap.
  const turnRecap =
    resolvedRecap && (!tailStatusOwner?.runId || tailStatusOwner.runId === resolvedRecap.runId)
      ? resolvedRecap
      : null;
  // Latest ownership crosses rows: the former owner must rerender when a
  // newer answer arrives even if its own message object stays stable.
  const latestAssistantItemKey =
    !props.runActive &&
    !props.runWorking &&
    !searchFiltering &&
    tailStatusOwner &&
    (tailStatusOwner.kind !== "group" || !tailStatusOwner.isStreaming)
      ? tailStatusOwner.key
      : null;
  const recapAttached = turnRecap !== null && tailStatusOwner?.runId === turnRecap.runId;
  const recapForGroup = (key: string) =>
    recapAttached && key === tailStatusOwner?.key ? (turnRecap ?? undefined) : undefined;
  const resolveReplyPreview = createReplyPreviewResolver(loadedReplySources, props);
  const sharedMessageRenderOptions = {
    presented,
    onReply: props.onSetReply
      ? (target) => state.transcriptRenderContext.onSetReply?.(target)
      : undefined,
    resolveReplyPreview,
    onOpenReply: (replyToId: string) => state.transcriptRenderContext.onOpenReply?.(replyToId),
    replyNavigationId: props.replyMessageAccess?.navigationId,
    onOpenSidebar: props.onOpenSidebar,
    sessionKey: props.sessionKey,
    boardProvider: props.boardProvider,
    widgetLayout: props.widgetLayout,
    agentId: assistantAgentId,
    runActive: props.runActive,
    asyncQuestions,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    onPermissionRetry: props.onPermissionRetry,
    mediaOwner: props.mediaOwner,
    resourceBasePath: props.resourceBasePath,
    mediaPolicyKey,
    connectionEpoch: props.connectionEpoch,
    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
    resolveArtifactDownload: props.resolveArtifactDownload,
    getTurnVideoMessages: (key) => state.transcriptRenderContext.turnVideoMessages?.get(key),
    onRequestOpenImage: props.onRequestOpenImage,
    onOpenImage: props.onOpenImage,
    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
    embedSandboxMode: props.embedSandboxMode ?? "scripts",
    allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
    fetchLinkFavicon: props.fetchLinkFavicon,
    pluginToolIcons: props.pluginToolIcons,
    showAssistantAvatar: avatarPlacement === "gutter",
    bubbleMode: props.chatBubbleMode === true && !searchFiltering,
  } satisfies StreamGroupOptions;
  const streamGroupOptions = {
    ...sharedMessageRenderOptions,
    branding: props.branding,
    assistant: assistantIdentity,
    startupLabel: props.startupLabel,
    retryAt: props.retryAt,
    waitingApproval: props.waitingApproval,
    waitingSubagents: subagents.wait ?? undefined,
    runningSubagents: subagents.running,
    subagentActivity: subagents.activity.length
      ? {
          rows: subagents.activity,
          presented,
          turnStartedAt: subagents.wait ? workingIndicator?.request?.askedAt : undefined,
          onOpenSubagent: props.onOpenSubagent,
          onOpenSession: props.onOpenSession,
        }
      : undefined,
    onOpenSubagents: subagents.listed ? props.onOpenSubagents : undefined,
    runOutputTokens,
    questionPrompts,
  } satisfies StreamGroupOptions;
  const renderGroupOptions = (item: MessageGroup) => {
    const continuation = continuations.get(item.key);
    const rewindEntryId =
      item.role.toLowerCase() === "user"
        ? persistedMessageEntryId(item.messages.at(-1)?.message)
        : null;
    return {
      ...sharedMessageRenderOptions,
      messageReactions: props.messageReactions,
      onReact: props.onReact,
      transcriptVisible: props.transcriptVisible,
      latestBrowserTabs: props.latestBrowserTabs,
      showReasoning,
      showToolCalls: props.showToolCalls,
      activityRunId,
      activityGroupKey,
      isToolMessageExpanded: (messageId: string) => expandedToolCards.get(messageId),
      onToggleToolMessageExpanded: toggleToolCardExpanded,
      isUserMessageExpanded: (messageId: string) => expandedUserMessages.get(messageId) ?? false,
      onToggleUserMessageExpanded: (messageId: string) => {
        setExpansionState(expandedUserMessages, messageId, !expandedUserMessages.get(messageId));
      },
      loadFullAssistantMessage: props.loadFullAssistantMessage ?? undefined,
      getAssistantMessageExpansion: recovery.get,
      onToggleAssistantMessageExpanded: recovery.expand,
      isToolExpanded: (toolCardId: string) => expandedToolCards.get(toolCardId) ?? false,
      onToggleToolExpanded: toggleToolCardExpanded,
      subagents: props,
      assistantName: props.assistantName,
      assistantAvatar: assistantIdentity.avatar,
      assistantTextAvatar: assistantIdentity.textAvatar,
      agents: props.agents,
      senderAgentAvatars: props.senderAgentAvatars,
      mainKey: props.mainKey,
      basePath: props.basePath,
      userId: props.userId ?? null,
      userName: props.userName ?? null,
      showOwnSenderName,
      userAvatar: props.userAvatar ?? null,
      channelAvatar: props.channelAvatar,
      onRetryQueuedMessage: props.onRetryQueuedMessage,
      connected: props.connected,
      onDiscardQueuedMessage: props.onDiscardQueuedMessage,
      queuedMessageAction: props.queuedMessageAction,
      personActivity: props.personActivity,
      avatarPlacement,
      contextWindow: threadContextWindow,
      onRewind:
        rewindEntryId && props.onRewindMessage
          ? () => {
              void Promise.resolve(props.onRewindMessage?.(rewindEntryId)).then((rewound) => {
                if (rewound) {
                  props.onFocusComposer?.();
                }
              });
            }
          : undefined,
      rewindDisabled: Boolean(props.runActive || props.runWorking),
      activeContinuation: continuation
        ? { parts: continuation, options: streamGroupOptions }
        : undefined,
      turnRecap: recapForGroup(item.key),
      latestAssistant: item.key === latestAssistantItemKey,
      searchResult: searchFiltering,
    } satisfies NativeMessageGroupOptions;
  };
  // Only the working indicator shows live usage and subagent status, so rows
  // without one keep memoizing across usage and child-roster patches.
  const workingUsageKey = JSON.stringify([runOutputTokens, subagents.statusKey]);
  const liveStatusSignature = (item: ChatRenderItem): string => {
    if (item.kind === "stream-run") {
      return item.parts.some((part) => part.kind === "reading-indicator") ? workingUsageKey : "";
    }
    if (item.kind !== "group" && item.kind !== "agent-run-frame") {
      return "";
    }
    const recap = recapForGroup(item.key);
    const recapKey = recap ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}` : "";
    const statusKey = `${recapKey}|${item.key === latestAssistantItemKey ? "latest-assistant" : ""}`;
    if (item.kind === "agent-run-frame") {
      const hasWorkingIndicator = item.parts.some(
        (part) =>
          part.kind === "stream-run" &&
          part.parts.some((streamPart) => streamPart.kind === "reading-indicator"),
      );
      return `${hasWorkingIndicator ? workingUsageKey : ""}|${statusKey}`;
    }
    const continuation = continuations.get(item.key);
    // Part keys stand in for the rest of the continuation: its remaining
    // options mirror props that already invalidate every row through the
    // shared render context.
    const continuationKey = continuation
      ? `${continuation.map((part) => part.key).join(" ")}${workingUsageKey}`
      : "";
    return `${continuationKey}|${statusKey}|${searchFiltering ? "search-result" : ""}`;
  };
  const renderItem = guardChatRenderItems(
    state,
    (item) => [liveStatusSignature(item), ...transcriptReplyDependencies(item, loadedReplySources)],
    (item) => {
      if (item.kind === "system-event-group") {
        return { kind: "system-events", item };
      }
      if (item.kind === "group") {
        return { kind: "group", group: item, options: renderGroupOptions(item) };
      }
      if (item.kind === "stream-run" || item.kind === "question") {
        return item.kind === "question"
          ? { kind: "stream", parts: [item], options: { questionPrompts } }
          : { kind: "stream", parts: item.parts, options: streamGroupOptions };
      }
      if (item.kind === "work-group") {
        const workExpanded = expandedToolCards.get(item.key) ?? false;
        return {
          kind: "work",
          item,
          options: {
            expanded: workExpanded,
            bubbleMode: props.chatBubbleMode === true && !searchFiltering,
            browserTabPreviews: workPreviews.get(item.key),
            onToggle: () => toggleToolCardExpanded(item.key, workExpanded),
          },
        };
      }
      if (item.kind === "activity-run") {
        const firstGroup = item.groups[0];
        if (!firstGroup) {
          return undefined;
        }
        return item.groups.length === 1
          ? { kind: "group", group: firstGroup, options: renderGroupOptions(firstGroup) }
          : {
              kind: "activity",
              groups: item.groups,
              options: renderGroupOptions(firstGroup),
              presentation: "standalone",
            };
      }
      if (item.kind === "agent-run-frame") {
        return {
          kind: "frame",
          frame: item,
          options: {
            basePath: props.basePath,
            sessionPublicOrigin: props.sessionPublicOrigin,
            streamOptions: streamGroupOptions,
            renderGroupOptions,
            isWorkExpanded: (key) => expandedToolCards.get(key) ?? false,
            onToggleWork: toggleToolCardExpanded,
            turnRecap: recapForGroup(item.key),
          },
        };
      }
      if (item.kind === "divider") {
        return { kind: "divider", item };
      }
      if (item.kind === "notice") {
        return {
          kind: "notice",
          item,
          onPermissionRetry: props.onPermissionRetry,
          recovery: props,
        };
      }
      return undefined;
    },
  );
  transcript.entryAnimations.project(chatItems);
  transcript.syncMessageRows(messageRowKeysById, transcriptMessageKeys);
  const contentRows: Extract<TranscriptRow, { kind: "content" }>[] = [];
  const appendContent = (key: string, content: NativeTranscriptView) =>
    contentRows.push({
      kind: "content",
      key,
      content: new GuardedTranscriptItem([content], content),
    });
  const realtimeConversation = projectRealtimeTalkConversation(props);
  if (realtimeConversation) {
    appendContent("realtime-talk", { kind: "realtime", ...realtimeConversation });
  }
  if (turnRecap !== null && !recapAttached && !isEmpty && !showLoadingSkeleton) {
    appendContent("turn-recap", { kind: "recap", recap: turnRecap });
  }
  if (subagents.wait && !subagents.placedWait && !searchFiltering) {
    appendContent("waiting-subagents", {
      kind: "wait",
      sessionKey: props.sessionKey,
      wait: subagents.wait,
      options: streamGroupOptions,
    });
  }
  if (props.typingActors?.length) {
    appendContent("presence:typing", {
      kind: "typing",
      actors: props.typingActors,
      avatarPlacement,
      overflow: props.typingOverflow,
    });
  }
  const transcriptRows = projectTranscriptRows(rows, workPreviews, contentRows);
  // Deferred palettes apply leaf branding after the preference snapshot.
  const appliedBranding = currentThemeBranding();
  trackTranscriptRenderDependencies(state, [
    locale,
    props.branding?.mascot,
    props.branding?.brandIcon,
    props.branding?.workingIndicator,
    props.branding?.avatarHat,
    props.branding?.artwork,
    props.branding?.workingPhrases,
    appliedBranding.mascot,
    appliedBranding.brandIcon,
    appliedBranding.workingIndicator,
    appliedBranding.artwork,
    appliedBranding.avatarHat,
    expandedToolCards,
    getExpansionStateVersion(expandedToolCards),
    expandedUserMessages,
    getExpansionStateVersion(expandedUserMessages),
    expandedAssistantMessages,
    getExpansionStateVersion(expandedAssistantMessages),
    // The host minute poll requests an update; this key crosses row guard() memoization.
    Math.floor(Date.now() / 60_000),
    props.latestBrowserTabs,
    props.sessionKey,
    presented,
    typeof props.transcriptVisible === "object"
      ? props.transcriptVisible.isPresented()
      : (props.transcriptVisible ?? true),
    // Invalidate settled rows when spawn metadata arrives, not on activity/title patches.
    avatarPlacement,
    // Launch rows show each subagent's name, state and duration.
    subagents.rowsKey,
    props.boardProvider,
    props.boardProvider?.canPinWidgets,
    props.boardProvider?.canPinMcpApps,
    props.boardProvider?.snapshot$.value.revision,
    props.fullMessageAgentId,
    Boolean(props.loadFullAssistantMessage),
    showReasoning,
    props.showToolCalls,
    props.chatBubbleMode,
    Boolean(props.runActive),
    activityRunId,
    activityGroupKey,
    Boolean(props.runWorking),
    Boolean(props.runFinalizing),
    props.startupLabel,
    props.retryAt,
    props.onRetryRun,
    props.failureActionsRunId,
    Boolean(props.waitingApproval),
    props.questionPrompts,
    state.asyncQuestionRevision,
    props.asyncQuestions?.historyKey,
    Boolean(props.autoExpandToolCalls),
    props.assistantName,
    assistantIdentity.avatar,
    assistantIdentity.textAvatar,
    props.currentAgentId,
    props.agents,
    props.senderAgentAvatars,
    props.mainKey,
    props.userId,
    props.userName,
    showOwnSenderName,
    props.userAvatar,
    ...channelSenderAvatarMemoKey(props.channelAvatar),
    props.resourceBasePath,
    props.basePath,
    props.sessionPublicOrigin,
    mediaPolicyKey,
    props.assistantAttachmentAuthToken,
    props.mediaOwner,
    props.connectionEpoch,
    props.canvasPluginSurfaceUrl,
    props.embedSandboxMode ?? "scripts",
    props.allowExternalEmbedUrls ?? false,
    Boolean(props.fetchLinkFavicon),
    props.pluginToolIcons,
    threadContextWindow,
    Boolean(props.onSetReply),
    props.messageReactions,
    Boolean(props.onReact),
    Boolean(props.asyncQuestions?.submit),
    Boolean(props.onRetryQueuedMessage),
    props.connected,
    Boolean(props.onDiscardQueuedMessage),
    props.queuedMessageAction?.id,
    props.queuedMessageAction?.label,
    props.queuedMessageAction?.onAction,
    props.replyMessageAccess?.revision ?? 0,
    props.replyMessageAccess?.navigationId ?? "",
    turnRecap === null ? "" : `${turnRecap.runtimeMs}:${turnRecap.outputTokens ?? ""}`,
  ]);
  const unfilteredItems = () =>
    buildCachedChatItems(
      { ...chatItemsInput, searchOpen: false, searchQuery: "", messageRecovery: undefined },
      "unfiltered",
    );
  state.transcriptRenderContext.turnVideoMessages = projectTurnVideoMessages(
    searchFiltering ? unfilteredItems() : chatItems,
  );
  state.transcriptRenderContext.onSetReply = props.onSetReply;
  state.transcriptRenderContext.onOpenReply = (replyToId) => {
    // Search removes rows from the index, not from loaded history. Resolve the
    // unfiltered projection only on navigation, using the same index/expansion
    // owners as visible targets rather than requiring a history loader.
    const targetChain = searchFiltering
      ? projectTranscriptChain(
          // Navigation expands the stabilized row keys of the visible cache;
          // the gallery cache owns membership, not mounted disclosure identity.
          buildCachedChatItems({ ...chatItemsInput, searchOpen: false, searchQuery: "" }),
          {
            sessionKey: props.sessionKey,
            runWorking: Boolean(props.runWorking),
            searchActive: false,
            bubbleMode: props.chatBubbleMode === true,
            session: activeSession,
          },
        )
      : transcriptChain;
    const targetSources =
      targetChain === transcriptChain
        ? loadedReplySources
        : projectTranscriptIndex(targetChain, expandedToolCards, props).loadedReplySources;
    const loaded = targetSources.has(replyToId);
    if (loaded) {
      expandReplyTargetWork(targetChain.transcriptItems, expandedToolCards, replyToId);
    }
    if (searchFiltering) {
      state.search.close();
    }
    if (loaded) {
      // Closing search must commit the original's row before reveal can find it.
      // Loaded originals also navigate in archived/read-only views.
      if (searchFiltering) {
        queueMicrotask(() => transcript.revealMessage(replyToId));
      } else {
        transcript.revealMessage(replyToId);
      }
      return;
    }
    props.replyMessageAccess?.open(replyToId);
  };
  return {
    isDirectThread,
    positionIndex: showLoadingSkeleton
      ? { markers: [], markerIdsByMessageId: new Map() }
      : positionIndex,
    isEmpty,
    showLoadingSkeleton,
    searchOpen: search.open,
    renderRows: (overlay: JSX.Element = null, header: TranscriptHeader | null = null) =>
      transcript.render(
        transcriptRows,
        (row) =>
          row.kind === "item"
            ? renderItem(row.key === liveItem?.key ? liveItem : row.item)
            : (contentRows.find((content) => content.key === row.key)?.content ?? row.content),
        latestTranscriptAnnouncement(collapsedItems, liveItem),
        props.announceTranscript !== false && !search.open && !props.loading,
        overlay,
        header,
        props.transcriptVisible ?? true,
        props.applicationContext,
      ),
  };
}
