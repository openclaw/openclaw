import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { groupReadsHandoffRoster } from "../chat-subagent-wait.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { readAsyncQuestions } from "./chat-async-question-content.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
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

export function inspectTranscriptContext(
  item: ChatRenderItem,
  loadedSources: ReadonlyMap<string, LoadedReplySource>,
  props: Pick<
    ChatThreadProps,
    | "onRetryRun"
    | "failedMessageEditSource"
    | "failureActionsRunId"
    | "modelCatalog"
    | "asyncQuestions"
  >,
  pendingSteer: NativeMessageGroupOptions["pendingSteer"],
) {
  const groups = chatItemGroups(item);
  const hasTools = groups.some((group) =>
    group.messages.some(({ message }) => extractToolCardsCached(message).length > 0),
  );
  // Launch rows and resume rules read the child roster.
  const readsRoster = hasTools || groups.some(groupReadsHandoffRoster);
  const hasQuestions =
    props.asyncQuestions &&
    groups.some((group) => group.messages.some(({ message }) => readAsyncQuestions(message)));
  const dependencies: unknown[] =
    item.kind === "notice"
      ? [
          props.onRetryRun,
          props.failedMessageEditSource,
          props.failureActionsRunId,
          item.modelChange ? props.modelCatalog : undefined,
        ]
      : [];
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
    dependencies.push(
      ...groups.flatMap((group) => group.messages.map(({ message }) => pendingSteer(message))),
    );
  }
  return [groups, hasTools, readsRoster, hasQuestions, dependencies] as const;
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
