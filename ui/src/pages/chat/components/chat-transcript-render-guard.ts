import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { messageClientSourcesKey } from "../../../../../src/chat/message-client-source.js";
import type { ChatItem, MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatThreadProps, ChatThreadState } from "./chat-thread-interactions.ts";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";

type ChatRenderItem = SystemEventRenderItem;
export type TranscriptDependencyItem =
  | ChatRenderItem
  | Extract<ChatItem, { kind: "stream" | "reading-indicator" | "question" }>;

/** The keyed virtual row owns the dependency memo and its rendered content. */
export class GuardedTranscriptItem {
  constructor(
    readonly dependencies: readonly unknown[],
    readonly native: NativeTranscriptView | undefined,
  ) {}
}

function groupDependencies(group: MessageGroup): readonly unknown[] {
  return [
    group.key,
    group.role,
    group.senderLabel,
    group.senderSession?.sessionKey,
    group.senderSession?.agentId,
    group.senderSession?.label,
    JSON.stringify(group.sender),
    messageClientSourcesKey(group.sourceClients ?? []),
    JSON.stringify(group.replyToSender),
    group.replyPreviousMessageId,
    group.replyShared,
    group.replyToMessage?.key,
    group.replyToMessage?.message,
    group.replyTurnSource?.key,
    group.replyTurnSource?.message,
    group.replyCurrentSource?.key,
    group.replyCurrentSource?.message,
    group.visibleContent,
    group.timestamp,
    group.isStreaming,
    group.runId,
    ...group.messages.flatMap((source) => [
      source.key,
      source.message,
      source.hasVisibleContent,
      JSON.stringify(source.replyTarget),
      // Cards expose mutable completion/error facts even when their message is retained.
      ...extractToolCardsCached(source.message).flatMap((card) => Object.values(card)),
    ]),
  ];
}

function itemDependencies(item: TranscriptDependencyItem): readonly unknown[] {
  if (item.kind === "group") {
    return groupDependencies(item);
  }
  if (item.kind === "system-event-group") {
    return [item.key, ...item.events];
  }
  if (item.kind === "stream-run") {
    return [
      item.key,
      item.runId,
      item.boundaryId,
      item.replyToSender,
      item.replyToMessage?.key,
      item.replyToMessage?.message,
      item.replyPreviousMessageId,
      ...item.parts,
    ];
  }
  if (item.kind === "work-group") {
    const anchors = Array.from(item.previewAfterGroup ?? []).flat();
    return [
      item.key,
      item.durationMs,
      item.replyRunId,
      item.ownerless,
      ...item.groups.flatMap(groupDependencies),
      ...anchors,
    ];
  }
  if (item.kind === "activity-run") {
    return [item.key, ...item.groups.flatMap(groupDependencies)];
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
      ...(item.detachedGroups ?? []).flatMap(groupDependencies),
    ];
  }
  return [item];
}

export function transcriptContextDependencies(
  item: TranscriptDependencyItem,
  loadedSources: ReadonlyMap<string, LoadedReplySource>,
  props: Pick<
    ChatThreadProps,
    | "onRetryRun"
    | "failedMessageEditSource"
    | "failureActionsRunId"
    | "modelCatalog"
    | "displayFacts"
    | "replyMessageAccess"
  >,
  presented: boolean,
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
      // Inline plugin rows need visibility to activate even without a tool card.
      const content = asNullableRecord(source.message)?.content;
      if (
        Array.isArray(content) &&
        content.some((block) => asNullableRecord(block)?.type === "plugin_view")
      ) {
        dependencies.push(presented);
      }
      const display = props.displayFacts?.forRow(persistedMessageEntryId(source.message))?.read();
      dependencies.push(display?.scope, display?.facts);
      if (source.replyTarget?.kind === "id") {
        const id = source.replyTarget.id;
        const loaded = loadedSources.get(id);
        dependencies.push(
          id,
          loaded?.message ?? props.replyMessageAccess?.read(id),
          loaded?.senderLabel,
          loaded ? undefined : props.replyMessageAccess?.status?.(id),
        );
      }
    }
  }
  return dependencies;
}

export function trackTranscriptRenderDependencies(
  state: ChatThreadState,
  dependencies: unknown[],
): void {
  const previous = state.transcriptRenderDependencies;
  if (!transcriptArraysEqual(dependencies, previous)) {
    state.transcriptRenderDependencies = dependencies;
  }
}

/** One dependency contract for virtual rows and retained parts within a frame. */
export function createTranscriptRenderDependencies(
  renderDependencies: readonly unknown[],
  presentationDependencies: (item: TranscriptDependencyItem) => readonly unknown[],
) {
  return (item: TranscriptDependencyItem): readonly unknown[] => [
    ...itemDependencies(item),
    renderDependencies,
    ...presentationDependencies(item),
  ];
}

export function guardChatRenderItems(
  dependencies: ReturnType<typeof createTranscriptRenderDependencies>,
  nativeFor: (item: ChatRenderItem) => NativeTranscriptView | undefined,
) {
  return (item: ChatRenderItem) => new GuardedTranscriptItem(dependencies(item), nativeFor(item));
}
