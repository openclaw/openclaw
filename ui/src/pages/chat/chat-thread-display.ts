import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { projectRunFailureStreaks } from "./chat-run-failure-streaks.ts";
import { projectSessionsYieldItems } from "./chat-sessions-yield.ts";
import type { BuildChatItemsProps } from "./chat-thread-build.ts";
import type { ChatItemsFacts } from "./chat-thread-facts.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { timestampAfterVisibleItems } from "./chat-thread-items.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";

export function groupChatDisplayItems(
  props: BuildChatItemsProps,
  sourceItems: ChatItem[],
  hidden?: ReadonlySet<string>,
  facts?: ChatItemsFacts,
  streamOnset?: Extract<ChatItem, { kind: "stream" }>,
): Array<ChatItem | MessageGroup> {
  const projectYields = (source: ChatItem[], complete?: ChatItem[]) =>
    projectSessionsYieldItems(source, props.showToolCalls, complete);
  // Keep real user boundaries even when search hides their rows.
  const items = projectRunFailureStreaks(sourceItems);
  const complete = hidden ? projectYields(coalesceToolActivityMessages(items)) : undefined;
  const projected = projectYields(coalesceToolActivityMessages(items, hidden), complete);
  // Empty streams count as a resumed handoff. Seed only after that projection, without one.
  const onset =
    streamOnset &&
    !complete &&
    !projected.some((item) => item.kind === "notice" && item.handoffBoundary)
      ? streamOnset
      : undefined;
  if (onset) {
    projected.splice(
      projected.findIndex((item) => item.kind === "reading-indicator" && item.key === onset.key),
      0,
      onset,
    );
  }
  const grouped = groupMessages(
    projected,
    { items: complete, people: props.replyPeople, localPerson: props.replyLocalPerson, facts },
    props.showReasoning ? props.reasoning : undefined,
    props.showReasoning,
  );
  if (facts && onset) {
    facts.streamOnset = onset;
    grouped.splice(grouped.indexOf(onset), 1);
  }
  return grouped;
}

export function prepareChatStreamOnset(
  props: BuildChatItemsProps,
  items: ChatItem[],
  indicator: Extract<ChatItem, { kind: "reading-indicator" }>,
  hasEmptyLiveStream: boolean,
): Extract<ChatItem, { kind: "stream" }> | undefined {
  if (
    props.runWorking === true &&
    (hasEmptyLiveStream || (props.stream === null && props.runId != null)) &&
    props.streamStartedAt !== null
  ) {
    return {
      ...indicator,
      kind: "stream",
      text: "",
      startedAt: timestampAfterVisibleItems(items, props.streamStartedAt),
      isStreaming: true,
    };
  }
  return undefined;
}
