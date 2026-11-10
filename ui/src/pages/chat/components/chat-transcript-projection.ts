import type { JSX } from "@solidjs/web";
import { merge } from "solid-js";
import { currentThemeBranding } from "../../../app/theme-branding.ts";
import { i18n } from "../../../i18n/index.ts";
import { channelSenderAvatarMemoKey } from "../../../lib/chat/channel-sender-avatar.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { localParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { assistantGroupCanOwnActiveRunStatus } from "../chat-assistant-reply.ts";
import { createPendingSteerLookup } from "../chat-pending-inputs.ts";
import { resolveTurnRecap, shouldRenderQueuedSendInThread } from "../chat-progress.ts";
import { projectChatReasoning } from "../chat-reasoning.ts";
import { groupReadsHandoffRoster, projectSubagentStatus } from "../chat-subagent-wait.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import {
  buildCachedChatItems,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  setExpansionState,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { readAsyncQuestions } from "./chat-async-question-content.ts";
import { buildChatArchiveNotice } from "./chat-divider.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import type { StreamGroupOptions } from "./chat-message-stream-view.tsx";
import { projectRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";
import {
  getTranscriptState,
  transcriptRewindOptions,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import {
  createTranscriptActions,
  createTranscriptMessageOptions,
} from "./chat-transcript-actions.ts";
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
  type PlacedContentRow,
} from "./chat-transcript-message-index.ts";
import { projectTranscriptRecovery } from "./chat-transcript-recovery.ts";
import {
  GuardedTranscriptItem,
  createTranscriptRenderDependencies,
  guardChatRenderItems,
  trackTranscriptRenderDependencies,
  transcriptContextDependencies,
  type TranscriptDependencyItem,
} from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";
import type { ChatTranscriptSession, TranscriptHeader } from "./chat-transcript-session.ts";
import { createTranscriptStreamSource } from "./chat-transcript-stream-source.ts";
import { projectTranscriptWorkPreviews } from "./chat-transcript-work-previews.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

const questionIndexes = createTranscriptMemo<NonNullable<StreamGroupOptions["questionPrompts"]>>();
const emptyQuestions: NonNullable<StreamGroupOptions["questionPrompts"]> = new Map();

export function projectChatTranscript(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
  search = getTranscriptState(props.paneId).search.snapshot,
) {
  const state = getTranscriptState(props.paneId);
  const { actions, dependencies: actionDependencies } = createTranscriptActions(
    state.transcriptRenderContext,
    props,
  );
  const actionProps = merge(props, actions);
  const realtimeConversation = projectRealtimeTalkConversation(props);
  const { asyncQuestions, selectedSession: activeSession } = props;
  const asyncQuestionGeneration = state.asyncQuestionGeneration;
  const { showOwnSenderName, replyPeople } = resolveTranscriptParticipants(props);
  const mediaPolicyKey = assistantMediaPolicyKey(activeSession, props.mediaPolicyEpoch);
  const { showReasoning, reasoning } = projectChatReasoning(props);
  const assistantAgentId = props.currentAgentId ?? props.fullMessageAgentId;
  const assistantAvatar = resolveAssistantDisplayAvatar(props, assistantAgentId);
  const assistantIdentity = {
    agentId: assistantAgentId,
    name: props.assistantName,
    avatar: assistantAvatar.avatar,
    textAvatar: assistantAvatar.textAvatar,
  };
  const locale = i18n.getLocale();
  const searchFiltering = search.open && Boolean(search.query.trim());
  const expandedAssistantMessages = transcript.expandedAssistantMessages;
  const recovery = projectTranscriptRecovery(expandedAssistantMessages, actionProps);
  const subagents = projectSubagentStatus(actionProps, searchFiltering);
  const chatItemsInput = {
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    archiveNotice: buildChatArchiveNotice(props.transcriptMetadata ?? activeSession),
    runId: props.runId ?? null,
    compactionStatus: props.compactionStatus,
    locale,
    messages: props.messages,
    toolMessages: props.toolMessages,
    guardianNotices: props.guardianNotices,
    streamSegments: props.streamSegments,
    get stream() {
      return props.stream ?? null;
    },
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
    messageRecovery: searchFiltering
      ? {
          messages: expandedAssistantMessages,
          revision: recovery.revision,
          agentId: props.fullMessageAgentId,
          displayFacts: props.displayFacts,
          canFetchFullMessage: Boolean(props.loadFullAssistantMessage),
        }
      : undefined,
  } satisfies Parameters<typeof buildCachedChatItems>[0];
  const { snapshot, live, resolveLiveStream } = createTranscriptStreamSource(
    chatItemsInput,
    searchFiltering,
  );
  const chatItems = snapshot.items;
  const {
    workingIndicator,
    activityRunId,
    activityGroupKey,
    runningActivityGroupKey,
    runOutputTokens,
  } = projectTranscriptActivity(chatItems, props);
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
  const hasTypingActors = (props.typingActors?.length ?? 0) > 0;
  const hasLiveContent = Boolean(
    subagents.wait || hasTypingActors || realtimeConversation.hasEntries(),
  );
  // An empty page is not an empty conversation. Keep the transcript mounted
  // while older history exists so the reader can request the next page.
  const isEmpty =
    transcriptItems.length === 0 &&
    !props.loading &&
    !hasLiveContent &&
    (!props.historyPagination?.hasMore || search.open);
  const { isDirectThread, avatarPlacement } = resolveTranscriptAvatarPlacement(props, chatItems);
  transcript.layout.configureRows(props, avatarPlacement, searchFiltering || recovery.revision > 0);
  const showLoadingSkeleton = props.loading && transcriptItems.length === 0 && !hasTypingActors;
  const presented =
    typeof props.presented === "object" ? props.presented.isPresented() : (props.presented ?? true);
  const threadContextWindow =
    props.transcriptMetadata?.contextTokens ??
    activeSession?.contextTokens ??
    props.sessions?.defaults?.contextTokens ??
    null;
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
  const recapRow = props.transcriptMetadata ?? activeSession;
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
    row: recapRow?.key === props.sessionKey ? recapRow : undefined,
    completedRunId: tailStatusOwner?.runId,
    usageByRun: props.runUsageById,
  });
  // An unwatched background run must not inherit the visible turn's recap.
  const turnRecap =
    resolvedRecap && (!tailStatusOwner?.runId || tailStatusOwner.runId === resolvedRecap.runId)
      ? resolvedRecap
      : null;
  // A newer answer must retire the former row's latest-owner presentation.
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
  const sharedMessageRenderOptions = createTranscriptMessageOptions(
    props,
    actions,
    state.transcriptRenderContext,
    {
      resolveLiveStream,
      resolveReplyPreview: createReplyPreviewResolver(loadedReplySources, props),
      presented,
      handoffSessionLinks: subagents.links,
      agentId: assistantAgentId,
      mediaPolicyKey,
      showAssistantAvatar: avatarPlacement === "gutter",
      bubbleMode: props.chatBubbleMode === true && !searchFiltering,
    },
  );
  // Actionable waits take precedence over the active tool bubble.
  const bubbleActivityGroupKey =
    props.showToolCalls && !props.waitingApproval && props.retryAt === undefined && !subagents.wait
      ? runningActivityGroupKey
      : undefined;
  const streamGroupOptions = {
    ...sharedMessageRenderOptions,
    branding: props.branding,
    bubbleActivityActive: bubbleActivityGroupKey !== undefined,
    assistant: assistantIdentity,
    startupLabel: props.startupLabel,
    retryAt: props.retryAt,
    waitingApproval: props.waitingApproval,
    waitingSubagents: subagents.wait
      ? {
          ...subagents.wait,
          startedAt: workingIndicator?.request?.askedAt ?? subagents.wait.startedAt,
        }
      : undefined,
    runningSubagents: subagents.running,
    onOpenSubagents: subagents.listed ? actions.onOpenSubagents : undefined,
    runOutputTokens,
    questionPrompts,
  } satisfies StreamGroupOptions;
  const pendingSteerForMessage = createPendingSteerLookup(props.pendingInputs);
  const renderGroupOptions = (item: MessageGroup) => {
    const continuation = continuations.get(item.key);
    return {
      ...sharedMessageRenderOptions,
      pendingSteer: pendingSteerForMessage,
      onSteerNow: actions.onSteerNow,
      messageReactions: props.messageReactions,
      onReact: props.onReact,
      latestBrowserTabs: props.latestBrowserTabs,
      showReasoning,
      showToolCalls: props.showToolCalls,
      activityRunId,
      activityGroupKey,
      bubbleActivityGroupKey,
      isToolMessageExpanded: (messageId: string) => expandedToolCards.get(messageId),
      onToggleToolMessageExpanded: toggleToolCardExpanded,
      isUserMessageExpanded: (messageId: string) => expandedUserMessages.get(messageId) ?? false,
      onToggleUserMessageExpanded: (messageId: string) => {
        setExpansionState(expandedUserMessages, messageId, !expandedUserMessages.get(messageId));
      },
      loadFullAssistantMessage: actions.loadFullAssistantMessage ?? undefined,
      getAssistantMessageExpansion: recovery.get,
      onToggleAssistantMessageExpanded: recovery.expand,
      isToolExpanded: (toolCardId: string) => expandedToolCards.get(toolCardId) ?? false,
      onToggleToolExpanded: toggleToolCardExpanded,
      subagents: actionProps,
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
      onRetryQueuedMessage: actions.onRetryQueuedMessage,
      connected: props.connected,
      onDiscardQueuedMessage: props.onDiscardQueuedMessage,
      queuedMessageAction: props.queuedMessageAction,
      personActivity: actions.personActivity,
      avatarPlacement,
      contextWindow: threadContextWindow,
      ...transcriptRewindOptions(item, actionProps),
      activeContinuation: continuation
        ? { parts: continuation, options: streamGroupOptions }
        : undefined,
      turnRecap: recapForGroup(item.key),
      turnDurations: transcriptChain.runDurations,
      latestAssistant: item.key === latestAssistantItemKey,
      searchResult: searchFiltering,
    } satisfies NativeMessageGroupOptions;
  };
  // Only working indicators depend on live usage and subagent status.
  const workingUsageKey = JSON.stringify([
    runOutputTokens,
    subagents.statusKey,
    presented,
    bubbleActivityGroupKey,
  ]);
  const liveStatusSignature = (item: TranscriptDependencyItem): string => {
    if (item.kind === "reading-indicator") {
      return workingUsageKey;
    }
    if (item.kind === "stream-run") {
      return item.parts.some((part) => part.kind === "reading-indicator") ? workingUsageKey : "";
    }
    if (item.kind !== "group" && item.kind !== "agent-run-frame") {
      return "";
    }
    const recap = recapForGroup(item.key);
    const recapKey = recap ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}` : "";
    const duration = item.runId ? transcriptChain.runDurations.get(item.runId) : undefined;
    const statusKey = `${recapKey}|${duration ?? ""}|${item.key === latestAssistantItemKey ? "latest-assistant" : ""}`;
    if (item.kind === "agent-run-frame") {
      const hasWorkingIndicator = item.parts.some(
        (part) =>
          part.kind === "stream-run" &&
          part.parts.some((streamPart) => streamPart.kind === "reading-indicator"),
      );
      return `${hasWorkingIndicator ? workingUsageKey : ""}|${statusKey}`;
    }
    const continuation = continuations.get(item.key);
    // Continuation options already participate in the shared render context.
    const continuationKey = continuation
      ? `${continuation.map((part) => part.key).join(" ")}${workingUsageKey}`
      : "";
    return `${continuationKey}|${statusKey}|${searchFiltering ? "search-result" : ""}`;
  };
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
    recovery.revision,
    props.latestBrowserTabs,
    ...actionDependencies,
    props.sessionKey,
    // Invalidate settled rows when spawn metadata arrives, not on activity/title patches.
    avatarPlacement,
    props.boardProvider,
    props.boardProvider?.canPinWidgets,
    props.boardProvider?.canPinMcpApps,
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
    props.mediaReadAllowed,
    props.connectionEpoch,
    props.canvasPluginSurfaceUrl,
    props.embedSandboxMode ?? "scripts",
    props.allowExternalEmbedUrls ?? false,
    props.fetchLinkFavicon,
    props.pluginToolIcons,
    threadContextWindow,
    Boolean(props.onSetReply),
    props.messageReactions,
    props.onReact,
    Boolean(props.asyncQuestions?.submit),
    Boolean(props.onRetryQueuedMessage),
    Boolean(props.onSteerNow),
    props.connected,
    props.onDiscardQueuedMessage,
    props.queuedMessageAction?.id,
    props.queuedMessageAction?.label,
    props.queuedMessageAction?.onAction,
    props.queuedMessageAction?.onDiscard,
    props.replyMessageAccess?.navigationId ?? "",
    turnRecap === null ? "" : `${turnRecap.runtimeMs}:${turnRecap.outputTokens ?? ""}`,
  ]);
  const renderDependencies = createTranscriptRenderDependencies(
    state.transcriptRenderDependencies,
    (item) => {
      const groups = chatItemGroups(item);
      const hasTools = groups.some((group) =>
        group.messages.some(({ message }) => extractToolCardsCached(message).length > 0),
      );
      // Launch rows and resume rules read the child roster.
      const readsRoster = hasTools || groups.some(groupReadsHandoffRoster);
      const hasQuestions =
        asyncQuestions &&
        groups.some((group) => group.messages.some(({ message }) => readAsyncQuestions(message)));
      return [
        liveStatusSignature(item),
        item.kind === "stream" || item.key === liveItem?.key ? resolveLiveStream : undefined,
        ...(workPreviews.get(item.key) ?? []).flatMap((preview) => [
          preview.preview,
          preview.revision,
          preview.latest,
        ]),
        ...transcriptContextDependencies(item, loadedReplySources, props, presented),
        ...(pendingSteerForMessage
          ? groups.flatMap((group) =>
              group.messages.map(({ message }) => pendingSteerForMessage(message)),
            )
          : []),
        // Durable drafts can restore the same map under a new callback generation.
        hasQuestions ? asyncQuestions : undefined,
        hasQuestions ? asyncQuestions.drafts : undefined,
        hasQuestions ? asyncQuestionGeneration : undefined,
        hasTools ? presented : undefined,
        readsRoster ? subagents.rowsKey : undefined,
      ];
    },
  );
  const renderItem = guardChatRenderItems(renderDependencies, (item) => {
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
          mediaReadAllowed: props.mediaReadAllowed,
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
          workPreviews,
          renderGroupOptions,
          partDependencies: renderDependencies,
          isWorkExpanded: (key) => expandedToolCards.get(key) ?? false,
          onToggleWork: toggleToolCardExpanded,
          turnRecap: recapForGroup(item.fragment?.source.key ?? item.key),
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
        modelCatalog: props.modelCatalog,
        onPermissionRetry: actions.onPermissionRetry,
        recovery: props,
      };
    }
    return undefined;
  });
  transcript.entryAnimations.project(chatItems);
  transcript.syncMessageRows(messageRowKeysById, transcriptMessageKeys);
  const contentRows: PlacedContentRow[] = [];
  const appendContent = (key: string, content: NativeTranscriptView, after?: string | null) =>
    contentRows.push({
      kind: "content",
      key,
      content: new GuardedTranscriptItem([content], content),
      after,
    });
  for (const { afterMessageId, content } of realtimeConversation.blocks()) {
    appendContent(
      afterMessageId === undefined ? "realtime-talk" : `realtime-talk:${afterMessageId ?? ""}`,
      content,
      afterMessageId ? messageRowKeysById.get(afterMessageId) : afterMessageId,
    );
  }
  if (turnRecap?.outputTokens != null && !recapAttached && !isEmpty && !showLoadingSkeleton) {
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
  state.transcriptRenderContext.threadMediaMessages = snapshot.threadMediaMessages;
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
  // Range-only renders reuse this projection; a new projection refreshes the
  // renderer for changed permissions, locale, content, or other presentation.
  const renderRow = (row: TranscriptRow<SystemEventRenderItem>) =>
    row.kind === "item"
      ? renderItem(row.key === liveItem?.key ? liveItem : row.item)
      : (contentRows.find((content) => content.key === row.key)?.content ?? row.content);
  return {
    isDirectThread,
    positionIndex: showLoadingSkeleton
      ? { markers: [], markerIdsByMessageId: new Map() }
      : {
          ...positionIndex,
          resolveLiveMessage: (message: unknown) =>
            message === transcriptChain.live?.message
              ? (live().prepared?.message ?? message)
              : message,
        },
    isEmpty,
    showLoadingSkeleton,
    searchOpen: search.open,
    renderRows: (overlay: JSX.Element = null, header: TranscriptHeader | null = null) =>
      transcript.render(
        transcriptRows,
        renderRow,
        latestTranscriptAnnouncement(collapsedItems, liveItem),
        props.announceTranscript !== false && !search.open && !props.loading,
        overlay,
        header,
        props.transcriptVisible ?? true,
        props.applicationContext,
      ),
  };
}
