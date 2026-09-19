// Chat-item projection, expansion, reply hydration, and guarded row rendering.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { nothing } from "lit";
import { classifySessionKind } from "../../../../../src/sessions/classify-session-kind.js";
import { markdownGitHubAliasSignature } from "../../../components/markdown-github-repositories.ts";
import { i18n } from "../../../i18n/index.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import {
  normalizeRoleForGrouping,
  resolveMessageRole,
  resolveMessageSender,
} from "../../../lib/chat/message-normalizer.ts";
import {
  isUiGlobalScopeConfigured,
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../../lib/sessions/session-key.ts";
import { agentRunFrameActiveStatusParts } from "../chat-agent-run-grouping.ts";
import { messageRecoveryKey } from "../chat-message-recovery.ts";
import { resolveTurnRecap, type TurnRecap } from "../chat-progress.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  buildCachedChatItems,
  coalesceAgentRunFrames,
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  persistedMessageEntryId,
  pruneAssistantMessageExpansions,
  setExpansionState,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";
import { renderAgentRunFrame } from "./chat-agent-run-frame.ts";
import { createAsyncQuestionPresentation } from "./chat-async-question.ts";
import { resolveChatDefaultAvatarPlacement } from "./chat-author-avatar.ts";
import { renderBackgroundTasksStatusRow } from "./chat-background-tasks-status.ts";
import { buildChatArchiveNotice, renderChatDivider, renderChatNotice } from "./chat-divider.ts";
import { resolveMessageReplyText } from "./chat-message-markdown.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import {
  getChatMediaRenderVersion,
  renderActivityGroup,
  renderMessageGroup,
  renderStreamGroup,
  renderWorkGroupSummary,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message.ts";
import { projectChatPositions } from "./chat-position-projection.ts";
import { renderRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";
import {
  closeTranscriptSearch,
  getTranscriptState,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import { renderBrowserTabPreviews } from "./chat-tool-cards.ts";
import { latestTranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { projectTranscriptMessageIndex } from "./chat-transcript-message-index.ts";
import {
  guardChatRenderItems,
  trackTranscriptRenderDependencies,
} from "./chat-transcript-render-guard.ts";
import type {
  ChatTranscriptProjection,
  ChatTranscriptSession,
  TranscriptHeader,
} from "./chat-transcript-session.ts";
import { renderChatTypingIndicator } from "./chat-typing-indicator.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

export function projectChatTranscript(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
): ChatTranscriptProjection {
  const state = getTranscriptState(props.paneId);
  const asyncQuestions = createAsyncQuestionPresentation(state, props);
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const displayStream = props.stream ?? null;
  const sessionHost = props.sessionHost ?? null;
  const activeSession = props.selectedSession;
  // Use unfiltered history and retained participants so searching or paging away
  // another person's messages cannot turn a shared conversation into a solo one.
  const showOwnSenderName =
    (activeSession?.expandedParticipants ?? activeSession?.participants ?? []).some(
      ({ identity }) =>
        identity.type !== "agent" && !(identity.type === "profile" && identity.id === props.userId),
    ) ||
    [...props.messages, ...(props.pendingInputs ?? []).map((input) => input.message)].some(
      (message) => {
        if (normalizeRoleForGrouping(resolveMessageRole(message)) !== "user") {
          return false;
        }
        const sender = resolveMessageSender(
          asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]),
        );
        return Boolean(
          sender && !(sender.identity?.type === "profile" && sender.identity.id === props.userId),
        );
      },
    );
  const mediaPolicyKey = assistantMediaPolicyKey(activeSession, props.mediaPolicyEpoch);
  // Global-alias routing ignores the capped session list, which may omit the
  // canonical row. The scope gate keeps per-sender main threads direct.
  const isGlobalAliasKey =
    parseAgentSessionKey(props.sessionKey)?.rest === "global" ||
    (sessionHost !== null &&
      isUiGlobalScopeConfigured(sessionHost) &&
      resolveUiGlobalAliasAgentId(sessionHost, props.sessionKey) !== null);
  const showReasoning = props.showThinking && activeSession?.reasoningLevel === "on";
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
  const searchFiltering = state.searchOpen && Boolean(state.searchQuery.trim());
  const expandedAssistantMessages = transcript.expandedAssistantMessages;
  const recoveryKey = (messageId: string) =>
    messageRecoveryKey(props.fullMessageAgentId, messageId);
  if (expandedAssistantMessages.size > 0) {
    pruneAssistantMessageExpansions(expandedAssistantMessages, props.fullMessageAgentId, [
      ...props.messages,
      ...props.toolMessages,
      ...(props.pendingInputs ?? []).map((input) => input.message),
    ]);
  }
  const chatItems = buildCachedChatItems({
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
    stream: displayStream,
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
    runActive: Boolean(props.runActive),
    questionPrompts: props.questionPrompts,
    loading: props.loading,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
    messageRecovery:
      searchFiltering && props.loadFullAssistantMessage
        ? {
            messages: expandedAssistantMessages,
            revision: getExpansionStateVersion(expandedAssistantMessages),
            agentId: props.fullMessageAgentId,
          }
        : undefined,
  });
  const workingIndicator = chatItems.find((item) => item.kind === "reading-indicator");
  const runOutputTokens = workingIndicator?.runId
    ? (props.runUsageById?.get(workingIndicator.runId)?.outputTokens ?? null)
    : null;
  const latestBrowserTabs = props.latestBrowserTabs;
  syncToolCardExpansionState(
    props.sessionKey,
    chatItems,
    Boolean(props.autoExpandToolCalls),
    searchFiltering || !props.showToolCalls,
  );
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const expandedUserMessages = getExpandedUserMessages(props.sessionKey);
  const questionPrompts = new Map(
    (props.questionPrompts ?? []).map((prompt) => [prompt.id, prompt]),
  );
  const toggleToolCardExpanded = (toolCardId: string, expanded?: boolean) => {
    setExpansionState(
      expandedToolCards,
      toolCardId,
      !(expanded ?? expandedToolCards.get(toolCardId) ?? false),
    );
    requestUpdate();
  };
  const toggleAssistantMessageExpanded = (messageId: string) => {
    const key = recoveryKey(messageId);
    const current = expandedAssistantMessages.get(key);
    const loader = props.loadFullAssistantMessage;
    if (!loader || current?.status === "loading") {
      return;
    }
    const revision = (current?.revision ?? 0) + 1;
    const pending = { status: "loading", revision } as const;
    setExpansionState(expandedAssistantMessages, key, pending);
    requestUpdate();
    const completeLoad = (result: Awaited<ReturnType<typeof loader>>) => {
      // A reset or source replacement can reuse both message id and revision.
      // Only the exact pending entry may publish into this presentation.
      if (expandedAssistantMessages.get(key) !== pending) {
        return;
      }
      const markdown =
        result?.ok && result.message && typeof result.message === "object"
          ? extractTextCached(result.message)
          : null;
      setExpansionState(
        expandedAssistantMessages,
        key,
        markdown === null
          ? { status: "error", revision: revision + 1 }
          : { status: "loaded", markdown, message: result?.message, revision: revision + 1 },
      );
      requestUpdate();
    };
    void loader({
      sessionKey: props.sessionKey,
      ...(props.fullMessageAgentId ? { agentId: props.fullMessageAgentId } : {}),
      messageId,
    }).then(completeLoad, () => completeLoad(null));
  };
  const hasRealtimeTalkConversation = (props.realtimeTalkConversation?.length ?? 0) > 0;
  const hasTypingActors = (props.typingActors?.length ?? 0) > 0;
  const isEmpty =
    chatItems.length === 0 && !props.loading && !hasRealtimeTalkConversation && !hasTypingActors;
  transcript.setContentReady(!props.loading);
  // 1:1 exchanges do not need an avatar gutter; group threads keep it to identify
  // multiple voices. The capped sessions list may omit the selected row, so absent
  // or unknown rows classify by key, with global aliases taking precedence.
  // senderLabels are not a signal: gateway sanitization also labels 1:1 channel DMs.
  const rowKind = activeSession?.kind;
  const sessionKind =
    rowKind && rowKind !== "unknown"
      ? rowKind
      : isGlobalAliasKey
        ? "global"
        : classifySessionKind(props.sessionKey);
  // Only agent-solo kinds qualify. Global sessions aggregate inbound contexts,
  // including groups/channels; identity-resolving gateways also share sessions
  // between people, so both keep avatars. A forwarded cross-session message adds
  // another voice to a direct exchange and restores identity chrome.
  const hasForwardedGroups = chatItems.some(
    (item) => item.kind === "group" && hasForwardedSource(item),
  );
  const defaultAvatarPlacement = resolveChatDefaultAvatarPlacement(
    (sessionKind === "direct" || sessionKind === "cron" || sessionKind === "spawn-child") &&
      !hasForwardedGroups,
    props.userId,
  );
  const isDirectThread = defaultAvatarPlacement === "footer";
  // Subagent sessions omit avatars; direct chats use the footer, others the gutter.
  const avatarPlacement =
    activeSession?.classification === "subagent" || isSubagentSessionKey(props.sessionKey)
      ? "none"
      : defaultAvatarPlacement;
  const showLoadingSkeleton = props.loading && chatItems.length === 0 && !hasTypingActors;
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;
  const activeContinuationByGroupKey = new Map<
    string,
    { parts: StreamGroupPart[]; options: StreamGroupOptions }
  >();
  const turnRecapByGroupKey = new Map<string, TurnRecap>();
  const loadedReplySources = new Map<string, LoadedReplySource>();
  const resolveReplyPreview = createReplyPreviewResolver(loadedReplySources, props);
  const sharedMessageRenderOptions = {
    entryRefFor: transcript.entryAnimations.refFor,
    presented: props.presented,
    onReply: props.onSetReply
      ? (target) => state.transcriptRenderContext.onSetReply?.(target)
      : undefined,
    onOpenSidebar: props.onOpenSidebar,
    sessionKey: props.sessionKey,
    boardProvider: props.boardProvider,
    agentId: props.currentAgentId ?? props.fullMessageAgentId,
    runActive: props.runActive,
    asyncQuestions,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    onRequestUpdate: requestUpdate,
    resourceBasePath: props.resourceBasePath,
    mediaPolicyKey,
    connectionEpoch: props.connectionEpoch,
    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
    resolveArtifactDownload: props.resolveArtifactDownload,
    onRequestOpenImage: props.onRequestOpenImage,
    onOpenImage: props.onOpenImage,
    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
    embedSandboxMode: props.embedSandboxMode ?? "scripts",
    allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
    fetchLinkFavicon: props.fetchLinkFavicon,
    pluginToolIcons: props.pluginToolIcons,
    githubRepo: props.githubRepo,
    githubRepositories: props.githubRepositories,
    showAssistantAvatar: avatarPlacement === "gutter",
  } satisfies StreamGroupOptions;
  const streamGroupOptions = {
    ...sharedMessageRenderOptions,
    assistant: assistantIdentity,
    startupLabel: props.startupLabel,
    waitingApproval: props.waitingApproval,
    runOutputTokens,
    questionPrompts,
  } satisfies StreamGroupOptions;
  // Latest ownership crosses rows: the former owner must rerender when a
  // newer answer arrives even if its own message object stays stable.
  let latestAssistantItemKey: string | null = null;
  const renderGroupOptions = (item: MessageGroup) => {
    const lastMessage = item.messages.at(-1)?.message;
    const rewindEntryId =
      item.role.toLowerCase() === "user" && lastMessage
        ? persistedMessageEntryId(lastMessage)
        : null;
    return {
      ...sharedMessageRenderOptions,
      transcriptVisible: props.transcriptVisible,
      latestBrowserTabs,
      showReasoning,
      showToolCalls: props.showToolCalls,
      autoExpandToolCalls: Boolean(props.autoExpandToolCalls),
      isToolMessageExpanded: (messageId: string) => expandedToolCards.get(messageId),
      onToggleToolMessageExpanded: toggleToolCardExpanded,
      isUserMessageExpanded: (messageId: string) => expandedUserMessages.get(messageId) ?? false,
      onToggleUserMessageExpanded: (messageId: string) => {
        setExpansionState(expandedUserMessages, messageId, !expandedUserMessages.get(messageId));
        requestUpdate();
      },
      loadFullAssistantMessage: props.loadFullAssistantMessage ?? undefined,
      getAssistantMessageExpansion: (messageId: string) =>
        expandedAssistantMessages.get(recoveryKey(messageId)),
      onToggleAssistantMessageExpanded: toggleAssistantMessageExpanded,
      isToolExpanded: (toolCardId: string) => expandedToolCards.get(toolCardId) ?? false,
      onToggleToolExpanded: toggleToolCardExpanded,
      assistantName: props.assistantName,
      assistantAvatar: assistantIdentity.avatar,
      assistantTextAvatar: assistantIdentity.textAvatar,
      agentId: assistantIdentity.agentId,
      agents: props.agents,
      senderAgentAvatars: props.senderAgentAvatars,
      mainKey: props.mainKey,
      userId: props.userId ?? null,
      userName: props.userName ?? null,
      showOwnSenderName,
      userAvatar: props.userAvatar ?? null,
      onRetryQueuedMessage: props.onRetryQueuedMessage,
      onDiscardQueuedMessage: props.onDiscardQueuedMessage,
      queuedMessageAction: props.queuedMessageAction,
      personActivity: props.personActivity,
      avatarPlacement,
      contextWindow: threadContextWindow,
      resolveReplyPreview,
      onResolveReply: props.replyMessageAccess?.request,
      onOpenReply: (replyToId: string) => state.transcriptRenderContext.onOpenReply?.(replyToId),
      replyNavigationId: props.replyMessageAccess?.navigationId,
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
      activeContinuation: activeContinuationByGroupKey.get(item.key),
      turnRecap: turnRecapByGroupKey.get(item.key),
      latestAssistant: item.key === latestAssistantItemKey,
    } satisfies Parameters<typeof renderMessageGroup>[1];
  };
  // Only the working indicator shows live usage, so rows without one keep
  // memoizing across usage patches.
  const workingUsageKey = `usage:${runOutputTokens ?? ""}`;
  const liveStatusSignature = (item: ChatRenderItem): string => {
    if (item.kind === "agent-run-frame") {
      const hasWorkingIndicator = item.parts.some(
        (part) =>
          part.kind === "stream-run" &&
          part.parts.some((streamPart) => streamPart.kind === "reading-indicator"),
      );
      const recap = turnRecapByGroupKey.get(item.key);
      return `${hasWorkingIndicator ? workingUsageKey : ""}|${
        recap ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}` : ""
      }|${item.key === latestAssistantItemKey ? "latest-assistant" : ""}`;
    }
    if (item.kind === "stream-run") {
      return item.parts.some((part) => part.kind === "reading-indicator") ? workingUsageKey : "";
    }
    if (item.kind !== "group") {
      return "";
    }
    const continuation = activeContinuationByGroupKey.get(item.key);
    const recap = turnRecapByGroupKey.get(item.key);
    // Part keys stand in for the rest of the continuation: its remaining
    // options mirror props that already invalidate every row through the
    // shared render context.
    const continuationKey = continuation
      ? `${continuation.parts.map((part) => part.key).join(" ")}${workingUsageKey}`
      : "";
    const recapKey = recap ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}` : "";
    return `${continuationKey}|${recapKey}|${
      item.key === latestAssistantItemKey ? "latest-assistant" : ""
    }`;
  };
  const renderItem = guardChatRenderItems(state, liveStatusSignature, (item) => {
    if (item.kind === "divider") {
      return renderChatDivider(item, props.onOpenSessionCheckpoints);
    }
    if (item.kind === "notice") {
      return renderChatNotice(item);
    }
    if (item.kind === "stream-run") {
      return renderStreamGroup(item.parts, streamGroupOptions);
    }
    if (item.kind === "work-group") {
      const workExpanded = expandedToolCards.get(item.key) ?? false;
      return renderWorkGroupSummary(item, {
        expanded: workExpanded,
        browserTabPreviews: renderBrowserTabPreviews(item.groups, {
          sessionKey: props.sessionKey,
          latestBrowserTabs,
        }),
        onToggle: () => toggleToolCardExpanded(item.key, workExpanded),
      });
    }
    if (item.kind === "activity-run") {
      const firstGroup = item.groups[0];
      if (!firstGroup) {
        return nothing;
      }
      return item.groups.length === 1
        ? renderMessageGroup(firstGroup, renderGroupOptions(firstGroup))
        : renderActivityGroup(item.groups, renderGroupOptions(firstGroup));
    }
    if (item.kind === "agent-run-frame") {
      return renderAgentRunFrame(item, {
        basePath: props.basePath,
        sessionPublicOrigin: props.sessionPublicOrigin,
        streamOptions: streamGroupOptions,
        renderGroupOptions,
        isWorkExpanded: (key) => expandedToolCards.get(key) ?? false,
        onToggleWork: toggleToolCardExpanded,
        turnRecap: turnRecapByGroupKey.get(item.key),
      });
    }
    if (item.kind === "group") {
      return renderMessageGroup(item, renderGroupOptions(item));
    }
    if (item.kind === "question") {
      return renderStreamGroup([item], {
        questionPrompts,
      });
    }
    return nothing;
  });
  const semanticItems = coalesceActivityRuns(
    collapseCompletedTurnWork(coalesceStreamRuns(chatItems), {
      sessionKey: props.sessionKey,
      runWorking: Boolean(props.runWorking),
      searchActive: searchFiltering,
    }),
    { searchActive: searchFiltering },
  );
  const collapsedItems = coalesceAgentRunFrames(semanticItems, { searchActive: searchFiltering });
  const resolvedRecap = resolveTurnRecap(state, {
    sessionKey: props.sessionKey,
    agentId: props.currentAgentId,
    gatewayClient: props.gatewayClient,
    indicator: workingIndicator,
    row: activeSession,
    usageByRun: props.runUsageById,
  });
  const transcriptItems = collapsedItems.filter((item, index) => {
    const previous = collapsedItems[index - 1];
    const activeStatusParts =
      item.kind === "stream-run" && item.parts.every((part) => part.kind === "reading-indicator")
        ? item.parts
        : item.kind === "agent-run-frame"
          ? agentRunFrameActiveStatusParts(item)
          : undefined;
    const activeStatusRunId =
      item.kind === "stream-run" || item.kind === "agent-run-frame" ? item.runId : undefined;
    if (
      previous?.kind !== "group" ||
      !activeStatusParts ||
      !assistantGroupCanOwnActiveRunStatus(previous) ||
      (previous.runId !== undefined &&
        activeStatusRunId !== undefined &&
        previous.runId !== activeStatusRunId)
    ) {
      return true;
    }
    // A reply and its still-running state are one turn-level presentation.
    // Keeping the status in the reply avoids a second claw/assistant row.
    activeContinuationByGroupKey.set(previous.key, {
      parts: activeStatusParts,
      options: streamGroupOptions,
    });
    return false;
  });
  // Default disclosure belongs only to a settled assistant at the transcript
  // tail; any newer visible row returns the prior answer to hover/tap behavior.
  const lastTranscriptItem = transcriptItems.at(-1);
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
  latestAssistantItemKey =
    !props.runActive &&
    !props.runWorking &&
    !searchFiltering &&
    tailStatusOwner &&
    (tailStatusOwner.kind !== "group" || !tailStatusOwner.isStreaming)
      ? tailStatusOwner.key
      : null;
  const { messageRowKeysById, transcriptMessageKeys, expandReplyTargetWork } =
    projectTranscriptMessageIndex(transcriptItems, expandedToolCards, props, loadedReplySources);
  const positionIndex = projectChatPositions(
    transcriptItems,
    expandedToolCards,
    messageRowKeysById,
  );
  transcript.entryAnimations.project(chatItems, props.sessionKey);
  transcript.syncMessageRows(messageRowKeysById, transcriptMessageKeys);
  let turnRecapOwnerKey: string | null = null;
  if (turnRecap !== null && tailStatusOwner?.runId === turnRecap.runId) {
    turnRecapByGroupKey.set(tailStatusOwner.key, turnRecap);
    turnRecapOwnerKey = tailStatusOwner.key;
  }
  // New row keys measure expanded work immediately; existing keys keep their
  // cached height until ResizeObserver reports the changed layout.
  const transcriptRows: TranscriptRow<ChatRenderItem>[] = [];
  for (const item of transcriptItems) {
    transcriptRows.push({ kind: "item", key: item.key, item });
    if (item.kind === "work-group" && expandedToolCards.get(item.key)) {
      for (const group of item.groups) {
        transcriptRows.push({ kind: "item", key: `${item.key}:${group.key}`, item: group });
      }
    }
  }
  const realtimeConversation = renderRealtimeTalkConversation(props);
  if (realtimeConversation !== nothing) {
    transcriptRows.push({
      kind: "content",
      key: "realtime-talk",
      content: realtimeConversation,
    });
  }
  if (turnRecap !== null && turnRecapOwnerKey === null && !isEmpty && !showLoadingSkeleton) {
    transcriptRows.push({
      kind: "content",
      key: "turn-recap",
      content: renderTurnRecapRow(turnRecap),
    });
  }
  const backgroundTasks =
    !props.runWorking && !isEmpty && !showLoadingSkeleton
      ? renderBackgroundTasksStatusRow(props.backgroundTasks)
      : nothing;
  if (backgroundTasks !== nothing) {
    transcriptRows.push({
      kind: "content",
      key: "background-tasks",
      content: backgroundTasks,
    });
  }
  const typingIndicator = renderChatTypingIndicator(props.typingActors, avatarPlacement);
  if (typingIndicator) {
    transcriptRows.push({ kind: "content", key: "presence:typing", content: typingIndicator });
  }
  trackTranscriptRenderDependencies(state, [
    locale,
    expandedToolCards,
    getExpansionStateVersion(expandedToolCards),
    expandedUserMessages,
    getExpansionStateVersion(expandedUserMessages),
    expandedAssistantMessages,
    getExpansionStateVersion(expandedAssistantMessages),
    getChatMediaRenderVersion(),
    // The host minute poll requests an update; this key crosses row guard() memoization.
    Math.floor(Date.now() / 60_000),
    JSON.stringify([...(latestBrowserTabs ?? [])]),
    props.sessionKey,
    props.presented,
    props.transcriptVisible,
    // Invalidate settled rows when spawn metadata arrives, not on activity/title patches.
    avatarPlacement,
    props.boardProvider,
    props.boardProvider?.canPinWidgets,
    props.boardProvider?.canPinMcpApps,
    props.boardProvider?.snapshot$.value.revision,
    props.fullMessageAgentId,
    Boolean(props.loadFullAssistantMessage),
    showReasoning,
    props.showToolCalls,
    Boolean(props.runActive),
    Boolean(props.runWorking),
    props.startupLabel,
    Boolean(props.waitingApproval),
    props.questionPrompts,
    state.asyncQuestionRevision,
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
    props.resourceBasePath,
    props.basePath,
    props.sessionPublicOrigin,
    mediaPolicyKey,
    props.assistantAttachmentAuthToken,
    props.connectionEpoch,
    props.canvasPluginSurfaceUrl,
    props.embedSandboxMode ?? "scripts",
    props.allowExternalEmbedUrls ?? false,
    Boolean(props.fetchLinkFavicon),
    props.pluginToolIcons,
    props.githubRepo?.owner,
    props.githubRepo?.repo,
    markdownGitHubAliasSignature(props.githubRepositories, props.githubRepo),
    threadContextWindow,
    Boolean(props.onSetReply),
    Boolean(props.onAsyncQuestionSubmit),
    Boolean(props.onRetryQueuedMessage),
    Boolean(props.onDiscardQueuedMessage),
    props.queuedMessageAction?.id,
    props.queuedMessageAction?.label,
    props.queuedMessageAction?.onAction,
    props.replyMessageAccess?.revision ?? 0,
    props.replyMessageAccess?.navigationId ?? "",
    turnRecap === null ? "" : `${turnRecap.runtimeMs}:${turnRecap.outputTokens ?? ""}`,
  ]);
  state.transcriptRenderContext.onSetReply = props.onSetReply;
  state.transcriptRenderContext.onAsyncQuestionSubmit = props.onAsyncQuestionSubmit;
  state.transcriptRenderContext.onOpenReply = (replyToId) => {
    const loaded = loadedReplySources.get(replyToId);
    if (loaded && resolveMessageReplyText(loaded.message)) {
      // Loaded targets also serve read-only views without reply-message access.
      // Reveal waits for this expansion to commit before locating the bubble.
      expandReplyTargetWork(replyToId);
      transcript.revealMessage(replyToId);
      return;
    }
    if (searchFiltering) {
      closeTranscriptSearch(state, requestUpdate);
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
    searchOpen: state.searchOpen,
    renderRows: (overlay: unknown = nothing, header: TranscriptHeader | null = null) =>
      transcript.render(
        transcriptRows,
        (row) => (row.kind === "item" ? renderItem(row.item) : row.content),
        latestTranscriptAnnouncement(collapsedItems),
        props.announceTranscript !== false && !state.searchOpen && !props.loading,
        overlay,
        header,
      ),
  };
}
