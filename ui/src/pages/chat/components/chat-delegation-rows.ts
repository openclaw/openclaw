import type { DelegatedTaskGroup } from "../chat-delegation.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import type { ChatDelegationProps } from "./chat-delegation.tsx";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";

const presentations = createTranscriptMemo<{
  rows: readonly TranscriptRow<SystemEventRenderItem>[];
  content: Map<string, GuardedTranscriptItem>;
}>();

/** Insert at the accepted launch's exact row, outside its collapsible work details. */
export function projectDelegationRows(
  rows: readonly TranscriptRow<SystemEventRenderItem>[],
  groups: ReadonlyMap<string, readonly DelegatedTaskGroup[]>,
  callbacks: Pick<ChatDelegationProps, "onOpenSubagent" | "onOpenSession">,
) {
  return presentations(rows, [groups, callbacks.onOpenSubagent, callbacks.onOpenSession], () => {
    const content = new Map<string, GuardedTranscriptItem>();
    const placed = rows.flatMap((row): TranscriptRow<SystemEventRenderItem>[] => {
      const tasks = groups.get(row.key);
      if (!tasks?.length) {
        return [row];
      }
      const key = "delegation:" + row.key;
      const view: NativeTranscriptView = { kind: "delegation", groups: tasks, ...callbacks };
      const guarded = new GuardedTranscriptItem([view], view);
      content.set(key, guarded);
      return [{ kind: "content", key, content: guarded }, row];
    });
    return { rows: placed, content };
  });
}
