import type { JSX } from "@solidjs/web";
import { untrack } from "solid-js";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import type { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-view.tsx";
import type { StreamGroupOptions, StreamGroupPart } from "./chat-message-stream.ts";
import type { ChatThreadState } from "./chat-thread-interactions.ts";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

/** The keyed virtual row owns the dependency memo and its rendered content. */
export class GuardedTranscriptItem {
  constructor(
    readonly dependencies: readonly unknown[],
    readonly render: () => JSX.Element,
    readonly stream?: { parts: StreamGroupPart[]; options: StreamGroupOptions },
    readonly legacy?: () => unknown,
    readonly group?: { group: MessageGroup; options: NativeMessageGroupOptions },
  ) {}
}

function itemDependencies(item: ChatRenderItem): readonly unknown[] {
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

export function trackTranscriptRenderDependencies(
  state: ChatThreadState,
  dependencies: unknown[],
): void {
  const previous = state.transcriptRenderDependencies;
  if (!transcriptArraysEqual(dependencies, previous)) {
    state.transcriptRenderDependencies = dependencies;
    state.transcriptRenderContext = {};
  }
}

export function guardChatRenderItems(
  state: ChatThreadState,
  // Reply sources and live status can change without replacing the row itself.
  presentationDependencies: (item: ChatRenderItem) => readonly unknown[],
  render: (item: ChatRenderItem) => JSX.Element,
  streamFor?: (item: ChatRenderItem) => GuardedTranscriptItem["stream"],
  legacyFor?: (item: ChatRenderItem) => GuardedTranscriptItem["legacy"],
  groupFor?: (item: ChatRenderItem) => GuardedTranscriptItem["group"],
) {
  return (item: ChatRenderItem) =>
    new GuardedTranscriptItem(
      [...itemDependencies(item), state.transcriptRenderContext, ...presentationDependencies(item)],
      () => untrack(() => render(item)),
      streamFor?.(item),
      legacyFor?.(item),
      groupFor?.(item),
    );
}
