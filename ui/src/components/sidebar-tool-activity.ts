import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { AgentActivityItemSchema } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SidebarToolActivity } from "./app-sidebar-session-types.ts";
import { deriveSidebarNarrationLine } from "./sidebar-narration-line.ts";

/** Read public progress only. Null withdraws matching activity; undefined ignores an event. */
export function readSidebarToolActivity(
  stream: unknown,
  value: unknown,
  previous?: SidebarToolActivity,
): SidebarToolActivity | null | undefined {
  if (stream !== "tool" && stream !== "item") {
    return undefined;
  }
  const data = asNullableObjectRecord(value);
  const candidate =
    stream === "item" ? Value.Clean(AgentActivityItemSchema, { ...data }) : undefined;
  const item = Value.Check(AgentActivityItemSchema, candidate) ? candidate : undefined;
  if (stream === "item" && (!item || item.kind !== "tool")) {
    return undefined;
  }
  const toolCallId =
    typeof data?.toolCallId === "string" ? data.toolCallId || undefined : undefined;
  const itemId = item?.itemId;
  // Item IDs and call IDs are distinct namespaces. Either retained identity
  // can fill an omitted field, but an explicit mismatch must fence the event.
  const sameItem = itemId && previous?.itemId ? itemId === previous.itemId : undefined;
  const sameCall =
    toolCallId && previous?.toolCallId ? toolCallId === previous.toolCallId : undefined;
  const sameActivity =
    (sameItem === true || sameCall === true) && sameItem !== false && sameCall !== false;
  if (data?.hideFromChannelProgress === true || data?.suppressChannelProgress === true) {
    // Later tool frames may omit descriptive metadata; the controller fences
    // the run, while the retained item/call identity owns withdrawal.
    return sameActivity ? null : undefined;
  }
  const name =
    (typeof data?.name === "string" ? data.name.trim() : "") ||
    (sameActivity ? previous?.name : undefined);
  if (!name) {
    return undefined;
  }
  const text = item
    ? deriveSidebarNarrationLine(item.progressText?.trim() || "") || undefined
    : sameActivity
      ? previous?.text
      : undefined;
  return {
    name,
    itemId: itemId ?? (sameActivity ? previous?.itemId : undefined),
    toolCallId: toolCallId ?? (sameActivity ? previous?.toolCallId : undefined),
    text,
  };
}
