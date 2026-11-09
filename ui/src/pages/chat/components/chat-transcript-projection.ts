import type { JSX } from "@solidjs/web";
import { currentThemeBranding } from "../../../app/theme-branding.ts";
import { channelSenderAvatarMemoKey } from "../../../lib/chat/channel-sender-avatar.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { assistantGroupCanOwnActiveRunStatus } from "../chat-assistant-reply.ts";
import { createPendingSteerLookup } from "../chat-pending-inputs.ts";
import { resolveTurnRecap, shouldRenderQueuedSendInThread } from "../chat-progress.ts";
import { groupReadsHandoffRoster } from "../chat-subagent-wait.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import {
  buildCachedChatItems,
  getChatItemsGeneration,
  syncToolCardExpansionState,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  setExpansionState,
} from "../chat-thread.ts";
import { readAsyncQuestions } from "./chat-async-question-content.ts";
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
import { projectTranscriptActivity } from "./chat-transcript-activity.ts";
import { latestTranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import { resolveTranscriptAvatarPlacement } from "./chat-transcript-identity.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";
import {
  expandReplyTargetWork,
  projectTranscriptChain,
  projectTranscriptIndex,
  projectTranscriptRows,
  type PlacedContentRow,
} from "./chat-transcript-message-index.ts";
import {
  GuardedTranscriptItem,
  guardChatRenderItems,
  trackTranscriptRenderDependencies,
  transcriptContextDependencies,
} from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";
import type { ChatTranscriptSession, TranscriptHeader } from "./chat-transcript-session.ts";
import {
  chatTranscriptInputs,
  createTranscriptStreamSource,
} from "./chat-transcript-stream-source.ts";
import { projectTranscriptWorkPreviews } from "./chat-transcript-work-previews.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

function chatTranscriptChain(
  chatItems: ReturnType<typeof buildCachedChatItems>,
  props: ChatThreadProps,
  searchFiltering: boolean,
) {
  syncToolCardExpansionState(
    props.sessionKey,
    chatItems,
    Boolean(props.autoExpandToolCalls),
    searchFiltering || !props.showToolCalls,
  );
  const chain = projectTranscriptChain(chatItems, {
    sessionKey: props.sessionKey,
    messages: props.messages,
    activeRunId: props.runActive || props.runWorking ? props.runId : null,
    runWorking: Boolean(props.runWorking),
    searchActive: searchFiltering,
    bubbleMode: props.chatBubbleMode === true,
    session: props.transcriptMetadata ?? props.selectedSession,
  });
  const replyNavigationId = props.replyMessageAccess?.navigationId;
  if (replyNavigationId) {
    expandReplyTargetWork(
      chain.transcriptItems,
      getExpandedToolCards(props.sessionKey),
      replyNavigationId,
    );
  }
  return chain;
}

/** Fill the canonical caches before admitting one complete initial transcript. */
export function* prepareChatTranscript(
  getProps: () => ChatThreadProps,
  getSession: (key: string) => ChatTranscriptSession,
) {
  let preparedItems: ReturnType<typeof buildCachedChatItems> | undefined;
  let preparedGeneration = -1;
  while (true) {
    const props = getProps();
    if (props.messages.length <= 512) {
      return;
    }
    const input = chatTranscriptInputs(props, getSession(props.sessionKey));
    // Freeze the live getter exactly as the stream source does before caching it.
    const items = buildCachedChatItems({ ...input.chatItemsInput });
    const generation = getChatItemsGeneration(items);
    // Keep grouping with item preparation; the admission task indexes and renders.
    const chain = chatTranscriptChain(items, props, input.searchFiltering);
    if (items !== preparedItems || generation !== preparedGeneration) {
      preparedItems = items;
      preparedGeneration = generation;
      yield;
      continue;
    }
    projectTranscriptIndex(chain, getExpandedToolCards(props.sessionKey), props);
    return;
  }
}

const questionIndexes = createTranscriptMemo<NonNullable<StreamGroupOptions["questionPrompts"]>>();
const emptyQuestions: NonNullable<StreamGroupOptions["questionPrompts"]> = new Map();

export function projectChatTranscript(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
  search = getTranscriptState(props.paneId).search.snapshot,
) {
  const state = getTranscriptState(props.paneId);
  const realtimeConversation = projectRealtimeTalkConversation(props);
  const { asyncQuestions, selectedSession: activeSession } = props;
  const asyncQuestionGeneration = state.asyncQuestionGeneration;
  const expandedAssistantMessages = transcript.expandedAssistantMessages;
  const { chatItemsInput, searchFiltering, showReasoning, showOwnSenderName, recovery, subagents } =
    chatTranscriptInputs(props, transcript, search);
  const mediaPolicyKey = assistantMediaPolicyKey(activeSession, props.mediaPolicyEpoch);
  const assistantAgentId = props.currentAgentId ?? props.fullMessageAgentId;
  const assistantAvatar = resolveAssistantDisplayAvatar(props, assistantAgentId);
  const assistantIdentity = {
    agentId: assistantAgentId,
    name: props.assistantName,
    avatar: assistantAvatar.avatar,
    textAvatar: assistantAvatar.textAvatar,
  };
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
  const transcriptChain = chatTranscriptChain(chatItems, props, searchFiltering);
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const expandedUserMessages = getExpandedUserMessages(props.sessionKey);
  const { collapsedItems, transcriptItems, continuations } = transcriptChain;
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
  const sharedMessageRenderOptions = {
    resolveLiveStream,
    presented,
    onReply: props.onSetReply
      ? (target) => state.transcriptRenderContext.onSetReply?.(target)
      : undefined,
    resolveReplyPreview: createReplyPreviewResolver(loadedReplySources, props),
    onOpenReply: (replyToId: string) => state.transcriptRenderContext.onOpenReply?.(replyToId),
    replyNavigationId: props.replyMessageAccess?.navigationId,
    onOpenSidebar: props.onOpenSidebar,
    sessionKey: props.sessionKey,
    handoffSessionLinks: subagents.links,
    boardProvider: props.boardProvider,
    widgetLayout: props.widgetLayout,
    displayFacts: props.displayFacts,
    agentId: assistantAgentId,
    runActive: props.runActive,
    asyncQuestions,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    onFindWorkspaceFile: props.onFindWorkspaceFile,
    onPermissionRetry: props.onPermissionRetry,
    mediaOwner: props.mediaOwner,
    mediaReadAllowed: props.mediaReadAllowed,
    resourceBasePath: props.resourceBasePath,
    mediaPolicyKey,
    connectionEpoch: props.connectionEpoch,
    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
    resolveArtifactDownload: props.resolveArtifactDownload,
    getThreadMediaMessages: (key) => state.transcriptRenderContext.threadMediaMessages?.get(key),
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
    onOpenSubagents: subagents.listed ? props.onOpenSubagents : undefined,
    runOutputTokens,
    questionPrompts,
  } satisfies StreamGroupOptions;
  const pendingSteerForMessage = createPendingSteerLookup(props.pendingInputs);
  const renderGroupOptions = (item: MessageGroup) => {
    const continuation = continuations.get(item.key);
    return {
      ...sharedMessageRenderOptions,
      pendingSteer: pendingSteerForMessage,
      onSteerNow: props.onSteerNow,
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
      ...transcriptRewindOptions(item, props),
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
  const workingUsageKey = JSON.stringify([
    runOutputTokens,
    subagents.statusKey,
    presented,
    bubbleActivityGroupKey,
  ]);
  const liveStatusSignature = (item: SystemEventRenderItem): string => {
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
  // Deferred palettes apply leaf branding after the preference snapshot.
  const appliedBranding = currentThemeBranding();
  trackTranscriptRenderDependencies(state, [
    chatItemsInput.locale,
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
    Boolean(props.fetchLinkFavicon),
    props.pluginToolIcons,
    threadContextWindow,
    Boolean(props.onSetReply),
    props.messageReactions,
    Boolean(props.onReact),
    Boolean(props.asyncQuestions?.submit),
    Boolean(props.onRetryQueuedMessage),
    Boolean(props.onSteerNow),
    props.connected,
    Boolean(props.onDiscardQueuedMessage),
    props.queuedMessageAction?.id,
    props.queuedMessageAction?.label,
    props.queuedMessageAction?.onAction,
    props.queuedMessageAction?.onDiscard,
    props.replyMessageAccess?.revision ?? 0,
    props.replyMessageAccess?.navigationId ?? "",
    turnRecap === null ? "" : `${turnRecap.runtimeMs}:${turnRecap.outputTokens ?? ""}`,
  ]);
  const renderItem = guardChatRenderItems(
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
        item.key === liveItem?.key ? resolveLiveStream : undefined,
        ...transcriptContextDependencies(item, loadedReplySources, props),
        ...(pendingSteerForMessage
          ? groups.flatMap((group) =>
              group.messages.map(({ message }) => pendingSteerForMessage(message)),
            )
          : []),
        // Durable drafts can restore the same map under a new callback generation.
        hasQuestions ? asyncQuestions.drafts : undefined,
        hasQuestions ? asyncQuestionGeneration : undefined,
        // Tool plugins own foreground activity.
        hasTools ? presented : undefined,
        readsRoster ? subagents.rowsKey : undefined,
      ];
    },
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
          onPermissionRetry: props.onPermissionRetry,
          recovery: props,
        };
      }
      return undefined;
    },
  );
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
