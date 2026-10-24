import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { projectRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";
import { transcriptRowTimestamp } from "./chat-transcript-timeline.ts";

type RealtimeTalkConversation = NonNullable<ReturnType<typeof projectRealtimeTalkConversation>>;
type RealtimeTalkProps = Parameters<typeof projectRealtimeTalkConversation>[0];

type TranscriptContentRow = Extract<TranscriptRow, { kind: "content" }>;

type PlacedTranscriptContentRow = TranscriptContentRow & { slot: number };

export function projectRealtimeTalkContentRows(
  rows: readonly TranscriptRow<SystemEventRenderItem>[],
  props: RealtimeTalkProps,
): PlacedTranscriptContentRow[] {
  const conversation = projectRealtimeTalkConversation(props);
  if (!conversation) {
    return [];
  }
  const segments: Array<{
    slot: number;
    timed: boolean;
    entries: RealtimeTalkConversation["entries"];
  }> = [];
  let previousSlot = 0;
  for (const entry of conversation.entries) {
    const timestamp =
      typeof entry.createdAtMs === "number" && Number.isFinite(entry.createdAtMs)
        ? entry.createdAtMs
        : undefined;
    const timed = timestamp !== undefined;
    const laterRow =
      timestamp === undefined
        ? -1
        : rows.findIndex((row) => {
            const rowTimestamp = transcriptRowTimestamp(row);
            return rowTimestamp !== undefined && rowTimestamp > timestamp;
          });
    const requestedSlot = laterRow < 0 ? rows.length : laterRow;
    // Provider order is authoritative. A delayed ASR final may carry a later
    // timestamp than its successor, so only advance through history rather than
    // moving a later provider entry back above an earlier one.
    const slot = Math.max(previousSlot, requestedSlot);
    previousSlot = slot;
    const previous = segments.at(-1);
    if (previous?.slot === slot && previous.timed === timed) {
      previous.entries.push(entry);
      continue;
    }
    segments.push({ slot, timed, entries: [entry] });
  }
  return segments.map((segment) => {
    const view: NativeTranscriptView = {
      kind: "realtime",
      ...conversation,
      entries: segment.entries,
    };
    return {
      kind: "content",
      key: `realtime-talk:${segment.entries[0]!.id}:${segment.entries.at(-1)!.id}`,
      slot: segment.slot,
      content: new GuardedTranscriptItem([view], view),
    };
  });
}
