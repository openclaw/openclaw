import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import type { TurnRecap } from "../chat-progress.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatThreadProps, ChatThreadState } from "./chat-thread-interactions.ts";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";

type ChatRenderItem = SystemEventRenderItem;

export function createTranscriptStatusSignature(
  workingUsageKey: string,
  latestAssistantItemKey: string | null,
  recapForGroup: (key: string) => TurnRecap | undefined,
  continuations: ReadonlyMap<string, readonly { key: string }[]>,
  searchFiltering: boolean,
) {
  return (item: ChatRenderItem): string => {
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
}

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

export function appendTranscriptContextDependencies(
  dependencies: unknown[],
  item: ChatRenderItem,
  groups: ReturnType<typeof chatItemGroups>,
  loadedSources: ReadonlyMap<string, LoadedReplySource>,
  props: ChatThreadProps,
  pendingSteer: NativeMessageGroupOptions["pendingSteer"],
): void {
  if (item.kind === "notice") {
    dependencies.push(
      props.onRetryRun,
      props.failedMessageEditSource,
      props.failureActionsRunId,
      item.modelChange ? props.modelCatalog : undefined,
    );
  }
  // The first fragment presents the final answer's reply attribution above the run.
  const replyGroups =
    item.kind === "agent-run-frame" && item.fragment?.first
      ? chatItemGroups(item.fragment.source)
      : groups;
  for (const group of replyGroups) {
    for (const source of group.messages) {
      if (source.replyTarget?.kind === "id") {
        const loaded = loadedSources.get(source.replyTarget.id);
        dependencies.push(source.replyTarget.id, loaded?.message, loaded?.senderLabel);
      }
    }
  }
  if (pendingSteer) {
    for (const group of groups) {
      for (const { message } of group.messages) {
        dependencies.push(pendingSteer(message));
      }
    }
  }
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
  const dependenciesFor = (item: ChatRenderItem) => [
    ...itemDependencies(item),
    renderDependencies,
    ...presentationDependencies(item),
  ];
  return {
    dependenciesFor,
    render: (item: ChatRenderItem) =>
      new GuardedTranscriptItem(dependenciesFor(item), nativeFor(item)),
  };
}
