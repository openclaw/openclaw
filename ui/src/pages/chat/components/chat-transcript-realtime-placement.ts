import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { projectRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";
import { transcriptRowTimestamp } from "./chat-transcript-timeline.ts";

type RealtimeTalkConversation = NonNullable<ReturnType<typeof projectRealtimeTalkConversation>>;
type RealtimeTalkProps = Parameters<typeof projectRealtimeTalkConversation>[0];

type TranscriptContentRow = Extract<TranscriptRow, { kind: "content" }>;

export function projectRealtimeTalkContentRows(
  rows: readonly TranscriptRow<SystemEventRenderItem>[],
  props: RealtimeTalkProps,
): TranscriptContentRow[] {
  const conversation = projectRealtimeTalkConversation(props);
  if (!conversation) {
    return [];
  }
  const segments: Array<{
    slot: number;
    timed: boolean;
    timestamp: number | undefined;
    entries: RealtimeTalkConversation["entries"];
  }> = [];
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
    const slot = laterRow < 0 ? rows.length : laterRow;
    const previous = segments.at(-1);
    if (previous?.slot === slot && previous.timed === timed) {
      previous.entries.push(entry);
      if (timestamp !== undefined) {
        previous.timestamp = Math.min(previous.timestamp ?? timestamp, timestamp);
      }
      continue;
    }
    segments.push({ slot, timed, timestamp, entries: [entry] });
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
      timestamp: segment.timestamp,
      content: new GuardedTranscriptItem([view], view),
    };
  });
}
