import type { SystemEventGroup, SystemEventItem } from "../../lib/chat/chat-types.ts";
import type { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";

export type SystemEventRenderItem =
  | ReturnType<typeof coalesceAgentRunFrames>[number]
  | SystemEventGroup;
type RenderItem = SystemEventRenderItem;

/** Presentation only: semantic turn and run grouping has already finished. */
export function coalesceSystemEvents(items: RenderItem[]): RenderItem[] {
  const result: RenderItem[] = [];
  let events: SystemEventItem[] = [];
  const flush = () => {
    if (events.length === 1) {
      result.push(events[0]!);
    } else if (events.length > 1) {
      result.push({ kind: "system-event-group", key: "system-events:" + events[0]!.key, events });
    }
    events = [];
  };
  for (const item of items) {
    if ((item.kind === "notice" || item.kind === "divider") && item.systemEvent) {
      events.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}
