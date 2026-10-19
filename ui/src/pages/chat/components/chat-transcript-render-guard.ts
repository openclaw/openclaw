import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import type { AgentRunFrame } from "./chat-agent-run-frame.tsx";
import type { ChatDivider, ChatNotice } from "./chat-divider.tsx";
import type { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
import type {
  StreamGroup,
  UnplacedSubagentWait,
  WorkGroupSummary,
} from "./chat-message-stream-view.tsx";
import type { RealtimeTalkConversation } from "./chat-realtime-controls.tsx";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatSystemEvents } from "./chat-system-events.tsx";
import type { ChatThreadState } from "./chat-thread-interactions.ts";
import type { TranscriptWorkPreviews } from "./chat-transcript-content.tsx";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";
import type { ChatTypingIndicator } from "./chat-typing-indicator.tsx";
import type { TurnRecapRow } from "./chat-working-indicator.tsx";

type ChatRenderItem = SystemEventRenderItem;

export type NativeTranscriptView =
  | ({ kind: "system-events" } & Parameters<typeof ChatSystemEvents>[0])
  | ({ kind: "group" } & Parameters<typeof MessageGroup>[0])
  | ({ kind: "activity" } & Parameters<typeof ActivityGroup>[0])
  | ({ kind: "stream" } & Parameters<typeof StreamGroup>[0])
  | ({ kind: "work" } & Parameters<typeof WorkGroupSummary>[0])
  | ({ kind: "frame" } & Parameters<typeof AgentRunFrame>[0])
  | ({ kind: "wait" } & Parameters<typeof UnplacedSubagentWait>[0])
  | ({ kind: "divider" } & Parameters<typeof ChatDivider>[0])
  | ({ kind: "notice" } & Parameters<typeof ChatNotice>[0])
  | ({ kind: "work-previews" } & Parameters<typeof TranscriptWorkPreviews>[0])
  | ({ kind: "realtime" } & Parameters<typeof RealtimeTalkConversation>[0])
  | ({ kind: "recap" } & Parameters<typeof TurnRecapRow>[0])
  | ({ kind: "typing" } & Parameters<typeof ChatTypingIndicator>[0]);

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
      ...item.parts.flatMap(itemDependencies),
    ];
  }
  return [item];
}

export function transcriptReplyDependencies(
  item: ChatRenderItem,
  loadedSources: ReadonlyMap<string, LoadedReplySource>,
): unknown[] {
  const dependencies: unknown[] = [];
  for (const group of chatItemGroups(item)) {
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
  state: ChatThreadState,
  // Reply sources and live status can change without replacing the row itself.
  presentationDependencies: (item: ChatRenderItem) => readonly unknown[],
  nativeFor: (item: ChatRenderItem) => NativeTranscriptView | undefined,
) {
  return (item: ChatRenderItem) =>
    new GuardedTranscriptItem(
      [
        ...itemDependencies(item),
        state.transcriptRenderDependencies,
        ...presentationDependencies(item),
      ],
      nativeFor(item),
    );
}
