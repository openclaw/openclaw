import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

type AgentRunFramePart = Extract<
  SystemEventRenderItem,
  { kind: "agent-run-frame" }
>["parts"][number];
type TimelineItem = SystemEventRenderItem | AgentRunFramePart;

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function itemTimestamp(item: TimelineItem): number | undefined {
  switch (item.kind) {
    case "message":
      return finiteTimestamp(asNullableRecord(item.message)?.timestamp);
    case "group":
    case "notice":
    case "divider":
      return finiteTimestamp(item.timestamp);
    case "stream":
    case "reading-indicator":
    case "question":
      return finiteTimestamp(item.startedAt);
    case "work-group":
    case "activity-run":
      return finiteTimestamp(item.groups[0]?.timestamp);
    case "stream-run":
      return finiteTimestamp(item.parts[0]?.startedAt);
    case "agent-run-frame":
      for (const part of item.parts) {
        const timestamp = itemTimestamp(part);
        if (timestamp !== undefined) {
          return timestamp;
        }
      }
      return undefined;
    case "system-event-group":
      return finiteTimestamp(item.events[0]?.timestamp);
  }
  return undefined;
}

export function transcriptRowTimestamp(
  row: TranscriptRow<SystemEventRenderItem>,
): number | undefined {
  return row.kind === "item" ? itemTimestamp(row.item) : undefined;
}
