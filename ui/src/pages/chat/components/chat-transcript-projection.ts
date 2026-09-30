// Chat-item projection, expansion, reply hydration, and guarded row rendering.
import { html, nothing } from "lit";
import { markdownGitHubAliasSignature } from "../../../components/markdown-github-repositories.ts";
import { currentThemeBranding } from "../../../components/neutral-mark.ts";
import { i18n } from "../../../i18n/index.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { localParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { messageRecoveryKey } from "../chat-message-recovery.ts";
import { resolveTurnRecap, type TurnRecap } from "../chat-progress.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  buildCachedChatItems,
  type coalesceAgentRunFrames,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  persistedMessageEntryId,
  setExpansionState,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { renderAgentRunFrame } from "./chat-agent-run-frame.ts";
import { buildChatArchiveNotice, renderChatDivider, renderChatNotice } from "./chat-divider.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import {
  getChatMediaRenderVersion,
  renderActivityGroup,
  renderMessageGroup,
  renderStreamGroup,
  renderWorkGroupSummary,
  type StreamGroupOptions,
} from "./chat-message.ts";
import { renderRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";
import {
  closeTranscriptSearch,
  getTranscriptState,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import { renderWorkGroupBrowserTabPreviews } from "./chat-tool-cards.ts";
import { projectTranscriptActivity } from "./chat-transcript-activity.ts";
import { latestTranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import {
  isTranscriptGlobalAlias,
  resolveTranscriptAvatarPlacement,
  resolveTranscriptParticipants,
} from "./chat-transcript-identity.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";
import {
  expandReplyTargetWork,
  projectTranscriptChain,
  projectTranscriptIndex,
} from "./chat-transcript-message-index.ts";
import { pruneTranscriptExpansions } from "./chat-transcript-recovery.ts";
import {
  guardChatRenderItems,
  trackTranscriptRenderDependencies,
} from "./chat-transcript-render-guard.ts";
import type {
  ChatTranscriptProjection,
  ChatTranscriptSession,
  TranscriptHeader,
} from "./chat-transcript-session.ts";
import { projectTurnVideoMessages } from "./chat-turn-video-gallery.ts";
import { renderChatTypingIndicator } from "./chat-typing-indicator.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];
const workPreviewCache =
  createTranscriptMemo<ReturnType<typeof renderWorkGroupBrowserTabPreviews>>();
const persistedMessageIds = createTranscriptMemo<Set<string | null>>();

export function projectChatTranscript(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
): ChatTranscriptProjection {
  const state = getTranscriptState(props.paneId);
  const asyncQuestions = props.asyncQuestions;
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const activeSession = props.selectedSession;
  const { showOwnSenderName, sessionPeople } = resolveTranscriptParticipants(props);
  const mediaPolicyKey = assistantMediaPolicyKey(activeSession, props.mediaPolicyEpoch);
  const isGlobalAliasKey = isTranscriptGlobalAlias(props);
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
  pruneTranscriptExpansions(expandedAssistantMessages, props);
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
    replyPeople: [...sessionPeople].toSorted(),
    replyLocalPerson: localParticipantIdentityKey(props.userId),
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
  } satisfies Parameters<typeof buildCachedChatItems>[0];
  const chatItems = buildCachedChatItems(chatItemsInput);
  const { workingIndicator, activityRunId, activityGroupKey, runOutputTokens } =
    projectTranscriptActivity(chatItems, props);
  const latestBrowserTabs = props.latestBrowserTabs;
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
    runWorking: Boolean(props.runWorking),
    searchActive: searchFiltering,
    session: activeSession,
  });
  const { collapsedItems, transcriptItems, continuations } = transcriptChain;
  const replyNavigationId = props.replyMessageAccess?.navigationId;
  if (replyNavigationId) {
    expandReplyTargetWork(transcriptItems, expandedToolCards, replyNavigationId);
  }
  const { messageRowKeysById, transcriptMessageKeys, loadedReplySources, positionIndex, rows } =
    projectTranscriptIndex(transcriptChain, expandedToolCards, props);
  const latestBrowserTabsKey = JSON.stringify([...(latestBrowserTabs ?? [])]);
  const workPreviews = workPreviewCache(
    transcriptChain.workGroups,
    [
      expandedToolCards,
      getExpansionStateVersion(expandedToolCards),
      props.sessionKey,
      latestBrowserTabsKey,
    ],
    () =>
      renderWorkGroupBrowserTabPreviews(
        transcriptChain.workGroups.filter((item) => !expandedToolCards.get(item.key)),
        { sessionKey: props.sessionKey, latestBrowserTabs },
      ),
  );
  const questionPrompts = new Map(
    (props.questionPrompts ?? []).map((prompt) => [prompt.id, prompt]),
  );
  const toggleToolCardExpanded = (toolCardId: string, expanded?: boolean) => {
    setExpansionState(
      expandedToolCards,
      toolCardId,
      !(expanded ?? expandedToolCards.get(toolCardId) ?? false),
    );
    state.transcriptRenderContext.onRequestUpdate?.();
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
  const { isDirectThread, avatarPlacement } = resolveTranscriptAvatarPlacement(
    props,
    chatItems,
    isGlobalAliasKey,
  );
  const showLoadingSkeleton = props.loading && chatItems.length === 0 && !hasTypingActors;
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;
  const turnRecapByGroupKey = new Map<string, TurnRecap>();
  const resolveReplyPreview = createReplyPreviewResolver(loadedReplySources, props);
  const sharedMessageRenderOptions = {
    entryRefFor: transcript.entryAnimations.refFor,
    presented: props.presented,
    onReply: props.onSetReply
      ? (target) => state.transcriptRenderContext.onSetReply?.(target)
      : undefined,
    resolveReplyPreview,
    onResolveReply: props.replyMessageAccess?.request,
    onOpenReply: (replyToId: string) => state.transcriptRenderContext.onOpenReply?.(replyToId),
    replyNavigationId: props.replyMessageAccess?.navigationId,
    onOpenSidebar: props.onOpenSidebar,
    sessionKey: props.sessionKey,
    boardProvider: props.boardProvider,
    agentId: assistantAgentId,
    runActive: props.runActive,
    asyncQuestions,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    onRequestUpdate: requestUpdate,
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
    githubRepo: props.githubRepo,
    githubRepositories: props.githubRepositories,
    showAssistantAvatar: avatarPlacement === "gutter",
  } satisfies StreamGroupOptions;
  const streamGroupOptions = {
    ...sharedMessageRenderOptions,
    branding: props.branding,
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
    const continuation = continuations.get(item.key);
    const lastMessage = item.messages.at(-1)?.message;
    const rewindEntryId =
      item.role.toLowerCase() === "user" && lastMessage
        ? persistedMessageEntryId(lastMessage)
        : null;
    return {
      ...sharedMessageRenderOptions,
      messageReactions: props.messageReactions,
      onReact: props.onReact,
      transcriptVisible: props.transcriptVisible,
      latestBrowserTabs,
      showReasoning,
      showToolCalls: props.showToolCalls,
      activityRunId,
      activityGroupKey,
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
      agents: props.agents,
      senderAgentAvatars: props.senderAgentAvatars,
      mainKey: props.mainKey,
      basePath: props.basePath,
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
      turnRecap: turnRecapByGroupKey.get(item.key),
      latestAssistant: item.key === latestAssistantItemKey,
      searchResult: searchFiltering,
    } satisfies Parameters<typeof renderMessageGroup>[1];
  };
  // Only the working indicator shows live usage, so rows without one keep
  // memoizing across usage patches.
  const workingUsageKey = JSON.stringify([runOutputTokens]);
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
    const continuation = continuations.get(item.key);
    const recap = turnRecapByGroupKey.get(item.key);
    // Part keys stand in for the rest of the continuation: its remaining
    // options mirror props that already invalidate every row through the
    // shared render context.
    const continuationKey = continuation
      ? `${continuation.map((part) => part.key).join(" ")}${workingUsageKey}`
      : "";
    const recapKey = recap ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}` : "";
    return `${continuationKey}|${recapKey}|${
      item.key === latestAssistantItemKey ? "latest-assistant" : ""
    }|${searchFiltering ? "search-result" : ""}`;
  };
  const rowPresentationDependencies = (item: ChatRenderItem): readonly unknown[] => {
    const dependencies: unknown[] = [liveStatusSignature(item)];
    for (const group of chatItemGroups(item)) {
      for (const source of group.messages) {
        if (source.replyTarget?.kind === "id") {
          const loaded = loadedReplySources.get(source.replyTarget.id);
          dependencies.push(source.replyTarget.id, loaded?.message, loaded?.senderLabel);
        }
      }
    }
    return dependencies;
  };
  const renderItem = guardChatRenderItems(state, rowPresentationDependencies, (item) => {
    if (item.kind === "divider") {
      return renderChatDivider(item);
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
        browserTabPreviews: workPreviews.get(item.key),
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
  const resolvedRecap = resolveTurnRecap(state, {
    sessionKey: props.sessionKey,
    agentId: props.currentAgentId,
    gatewayClient: props.gatewayClient,
    indicator: workingIndicator,
    row: activeSession,
    usageByRun: props.runUsageById,
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
  transcript.entryAnimations.project(chatItems);
  transcript.syncMessageRows(messageRowKeysById, transcriptMessageKeys);
  if (turnRecap !== null && tailStatusOwner?.runId === turnRecap.runId) {
    turnRecapByGroupKey.set(tailStatusOwner.key, turnRecap);
  }
  const transcriptRows: TranscriptRow<ChatRenderItem>[] = workPreviews.size ? [] : rows.slice();
  for (const row of workPreviews.size ? rows : []) {
    transcriptRows.push(row);
    const previews = workPreviews.get(row.key);
    if (previews && !(row.kind === "item" && row.item.kind === "work-group")) {
      transcriptRows.push({
        kind: "content",
        key: `work-previews:${row.key}`,
        content: html`<div class="chat-group tool chat-group--turn-block">
          <div class="chat-group-messages">${previews}</div>
        </div>`,
      });
    }
  }
  // The live voice-turn block renders at the tail while typed messages sort into
  // history above it. Finalized voice turns are already persisted, so an explicit
  // idle session (realtimeTalkActive === false) hides the block and lets history
  // own chronology. Unset callers keep the block; production always sets the flag.
  const realtimeConversation =
    props.realtimeTalkActive !== false
      ? renderRealtimeTalkConversation({
          ...props,
          realtimeTalkConversation: props.realtimeTalkConversation?.filter((entry) => {
            if (!entry.transcriptId) {
              return true;
            }
            return !persistedMessageIds(
              props.messages,
              [],
              () => new Set(props.messages.map(persistedMessageEntryId)),
            ).has(entry.transcriptId);
          }),
        })
      : nothing;
  if (realtimeConversation !== nothing) {
    transcriptRows.push({
      kind: "content",
      key: "realtime-talk",
      content: realtimeConversation,
    });
  }
  if (turnRecap !== null && turnRecapByGroupKey.size === 0 && !isEmpty && !showLoadingSkeleton) {
    transcriptRows.push({
      kind: "content",
      key: "turn-recap",
      content: renderTurnRecapRow(turnRecap),
    });
  }
  const typingIndicator = renderChatTypingIndicator(
    props.typingActors,
    avatarPlacement,
    props.typingOverflow,
  );
  if (typingIndicator) {
    transcriptRows.push({ kind: "content", key: "presence:typing", content: typingIndicator });
  }
  // Deferred palettes apply leaf branding after the preference snapshot.
  const appliedBranding = currentThemeBranding();
  trackTranscriptRenderDependencies(state, [
    locale,
    props.branding?.mascot,
    props.branding?.avatarHat,
    props.branding?.artwork,
    props.branding?.workingPhrases,
    appliedBranding.mascot,
    appliedBranding.avatarHat,
    expandedToolCards,
    getExpansionStateVersion(expandedToolCards),
    expandedUserMessages,
    getExpansionStateVersion(expandedUserMessages),
    expandedAssistantMessages,
    getExpansionStateVersion(expandedAssistantMessages),
    getChatMediaRenderVersion(),
    // The host minute poll requests an update; this key crosses row guard() memoization.
    Math.floor(Date.now() / 60_000),
    latestBrowserTabsKey,
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
    activityRunId,
    activityGroupKey,
    Boolean(props.runWorking),
    props.startupLabel,
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
    props.messageReactions,
    Boolean(props.onReact),
    Boolean(props.asyncQuestions?.submit),
    Boolean(props.onRetryQueuedMessage),
    Boolean(props.onDiscardQueuedMessage),
    props.queuedMessageAction?.id,
    props.queuedMessageAction?.label,
    props.queuedMessageAction?.onAction,
    props.replyMessageAccess?.revision ?? 0,
    props.replyMessageAccess?.navigationId ?? "",
    turnRecap === null ? "" : `${turnRecap.runtimeMs}:${turnRecap.outputTokens ?? ""}`,
  ]);
  // Rebind disclosures to the current pane without repainting unchanged rows.
  state.transcriptRenderContext.onRequestUpdate = props.onRequestUpdate;
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
      closeTranscriptSearch(state, requestUpdate);
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
    searchOpen: state.searchOpen,
    renderRows: (overlay: unknown = nothing, header: TranscriptHeader | null = null) =>
      transcript.render(
        transcriptRows,
        (row) => (row.kind === "item" ? renderItem(row.item) : row.content),
        latestTranscriptAnnouncement(collapsedItems),
        props.announceTranscript !== false && !state.searchOpen && !props.loading,
        overlay,
        header,
        Boolean(replyNavigationId),
      ),
  };
}
