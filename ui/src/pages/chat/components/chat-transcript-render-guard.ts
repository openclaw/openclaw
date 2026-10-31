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
  props: Pick<ChatThreadProps, "onRetryRun" | "failureActionsRunId" | "modelCatalog">,
): unknown[] {
  if (item.kind === "notice") {
    return [
      props.onRetryRun,
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
  dependencies: unknown[],
): void {
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
