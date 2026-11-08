import { channelSenderAvatarMemoKey } from "../../../lib/chat/channel-sender-avatar.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatThreadProps, ChatThreadState } from "./chat-thread-interactions.ts";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";

type ChatRenderItem = SystemEventRenderItem;

/** The keyed virtual row owns the dependency memo and its rendered content. */
export class GuardedTranscriptItem {
  constructor(
    readonly dependencies: readonly unknown[],
    readonly native: NativeTranscriptView | undefined,
  ) {}
}

function itemDependencies(item: ChatRenderItem): readonly unknown[] {
  if (item.kind === "system-event-group") {
    return [item.key, ...item.events];
  }
  if (item.kind === "stream-run") {
    return [item.key, ...item.parts];
  }
  if (item.kind === "work-group") {
    const anchors = Array.from(item.previewAfterGroup ?? []).flat();
    return [item.key, item.durationMs, ...item.groups, ...anchors];
  }
  if (item.kind === "activity-run") {
    return [item.key, ...item.groups];
  }
  if (item.kind === "agent-run-frame") {
    const outcome = item.outcome;
    // Grouping recreates frame wrappers; only the outcome and nested content invalidate a row.
    return [
      item.key,
      outcome.kind,
      outcome.kind === "completed" ? outcome.actionOwner : null,
      item.fragment?.first,
      item.fragment?.last,
      item.fragment?.firstBubbleKey,
      item.fragment?.representative,
      item.fragment?.source.parts,
      ...item.parts.flatMap(itemDependencies),
    ];
  }
  return [item];
}

export function transcriptContextDependencies(
  item: ChatRenderItem,
  loadedSources: ReadonlyMap<string, LoadedReplySource>,
  props: Pick<
    ChatThreadProps,
    "onRetryRun" | "failedMessageEditSource" | "failureActionsRunId" | "modelCatalog"
  >,
): unknown[] {
  if (item.kind === "notice") {
    return [
      props.onRetryRun,
      props.failedMessageEditSource,
      props.failureActionsRunId,
      item.modelChange ? props.modelCatalog : undefined,
    ];
  }
  const dependencies: unknown[] = [];
  // The first fragment presents the final answer's reply attribution above the run.
  const replySource =
    item.kind === "agent-run-frame" && item.fragment?.first ? item.fragment.source : item;
  for (const group of chatItemGroups(replySource)) {
    for (const source of group.messages) {
      if (source.replyTarget?.kind === "id") {
        const loaded = loadedSources.get(source.replyTarget.id);
        dependencies.push(source.replyTarget.id, loaded?.message, loaded?.senderLabel);
      }
    }
  }
  return dependencies;
}

export function trackTranscriptRenderDependencies(
  state: ChatThreadState,
  props: ChatThreadProps,
  derived: unknown[],
): void {
  const dependencies: unknown[] = [
    ...derived,
    props.branding?.mascot,
    props.branding?.brandIcon,
    props.branding?.workingIndicator,
    props.branding?.avatarHat,
    props.branding?.artwork,
    props.branding?.workingPhrases,
    props.latestBrowserTabs,
    props.widgetLayout,
    Boolean(props.displayFacts),
    props.personActivity?.basePath,
    Boolean(props.personActivity),
    Boolean(props.onOpenSidebar),
    Boolean(props.onOpenWorkspaceFile),
    Boolean(props.onFindWorkspaceFile),
    Boolean(props.onPermissionRetry),
    props.resolveArtifactDownload,
    props.onRequestOpenImage,
    Boolean(props.onOpenImage),
    Boolean(props.onAssistantAttachmentLoaded),
    Boolean(props.onOpenSessionLink),
    Boolean(props.onOpenSubagent),
    Boolean(props.onOpenSubagents),
    Boolean(props.onRewindMessage),
    Boolean(props.onFocusComposer),
    props.sessionKey,
    props.boardProvider,
    props.boardProvider?.canPinWidgets,
    props.boardProvider?.canPinMcpApps,
    props.fullMessageAgentId,
    Boolean(props.loadFullAssistantMessage),
    props.showToolCalls,
    props.chatBubbleMode,
    Boolean(props.runActive),
    Boolean(props.runWorking),
    Boolean(props.runFinalizing),
    props.startupLabel,
    props.retryAt,
    Boolean(props.waitingApproval),
    props.questionPrompts,
    props.asyncQuestions?.historyKey,
    Boolean(props.autoExpandToolCalls),
    props.assistantName,
    props.currentAgentId,
    props.agents,
    props.senderAgentAvatars,
    props.mainKey,
    props.userId,
    props.userName,
    props.userAvatar,
    ...channelSenderAvatarMemoKey(props.channelAvatar),
    props.resourceBasePath,
    props.basePath,
    props.sessionPublicOrigin,
    props.assistantAttachmentAuthToken,
    props.mediaOwner,
    props.mediaReadAllowed,
    props.connectionEpoch,
    props.canvasPluginSurfaceUrl,
    props.embedSandboxMode ?? "scripts",
    props.allowExternalEmbedUrls ?? false,
    props.fetchLinkFavicon,
    props.pluginToolIcons,
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
    props.replyMessageAccess?.revision ?? 0,
    props.replyMessageAccess?.navigationId ?? "",
  ];
  const previous = state.transcriptRenderDependencies;
  if (!transcriptArraysEqual(dependencies, previous)) {
    state.transcriptRenderDependencies = dependencies;
  }
}

export function guardChatRenderItems(
  renderDependencies: readonly unknown[],
  // Reply sources and live status can change without replacing the row itself.
  presentationDependencies: (item: ChatRenderItem) => readonly unknown[],
  nativeFor: (item: ChatRenderItem) => NativeTranscriptView | undefined,
) {
  return (item: ChatRenderItem) =>
    new GuardedTranscriptItem(
      [...itemDependencies(item), renderDependencies, ...presentationDependencies(item)],
      nativeFor(item),
    );
}

/** Retained rows dispatch through the current pane action owner. */
export function projectTranscriptActions(state: ChatThreadState, props: ChatThreadProps) {
  const context = state.transcriptRenderContext;
  context.actions = props;
  const displayFacts = props.displayFacts;
  // Retained rows keep these dispatchers; each call uses the current pane owner.
  const actions: NonNullable<typeof context.actions> = {
    onOpenSidebar: props.onOpenSidebar
      ? (content) => context.actions?.onOpenSidebar?.(content)
      : undefined,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile
      ? (target) => context.actions?.onOpenWorkspaceFile?.(target)
      : undefined,
    onFindWorkspaceFile: props.onFindWorkspaceFile
      ? (target) => context.actions?.onFindWorkspaceFile?.(target)
      : undefined,
    onPermissionRetry: props.onPermissionRetry
      ? (message) => context.actions?.onPermissionRetry?.(message)
      : undefined,
    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded
      ? () => context.actions?.onAssistantAttachmentLoaded?.()
      : undefined,
    onOpenSessionLink: props.onOpenSessionLink
      ? (target) => context.actions?.onOpenSessionLink?.(target)
      : undefined,
    onOpenSubagent: props.onOpenSubagent
      ? (key) => context.actions?.onOpenSubagent?.(key)
      : undefined,
    onOpenSubagents: props.onOpenSubagents
      ? (focus) => context.actions?.onOpenSubagents?.(focus)
      : undefined,
    onRetryQueuedMessage: props.onRetryQueuedMessage
      ? (id) => context.actions?.onRetryQueuedMessage?.(id)
      : undefined,
    onSteerNow: props.onSteerNow ? (runId) => context.actions?.onSteerNow?.(runId) : undefined,
    onFocusComposer: props.onFocusComposer ? () => context.actions?.onFocusComposer?.() : undefined,
    onOpenImage: props.onOpenImage
      ? (item, requestVersion) => context.actions?.onOpenImage?.(item, requestVersion)
      : undefined,
    onRewindMessage: props.onRewindMessage
      ? (entryId) => context.actions?.onRewindMessage?.(entryId) ?? false
      : undefined,
    loadFullAssistantMessage: props.loadFullAssistantMessage
      ? async (request) => context.actions?.loadFullAssistantMessage?.(request)
      : undefined,
    personActivity: props.personActivity
      ? {
          basePath: props.personActivity.basePath,
          navigate: (personId, label) => context.actions?.personActivity?.navigate(personId, label),
        }
      : undefined,
    displayFacts: displayFacts
      ? {
          forRow: (id) => {
            const original = displayFacts.forRow(id);
            return original
              ? {
                  read: () => {
                    const current = context.actions?.displayFacts?.forRow(id)?.read();
                    return current && current.scope === original.read()?.scope
                      ? current
                      : undefined;
                  },
                  write: (update) => {
                    const current = context.actions?.displayFacts?.forRow(id);
                    const scope = original.read()?.scope;
                    // An old row must not write into a different session's display cache.
                    if (scope && current?.read()?.scope === scope) {
                      current.write(update);
                    }
                  },
                }
              : undefined;
          },
        }
      : undefined,
  };
  return actions;
}
