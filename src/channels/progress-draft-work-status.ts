import { redactToolPayloadText } from "../logging/redact.js";
import type { ItemProgressPayload } from "./progress-draft-events.js";
import type { ChannelProgressDraftLine } from "./progress-draft-lines.js";
import { buildChannelProgressDraftLine } from "./streaming.js";

/** Status is not a tool log: never project arguments, command titles or result prose. */
export function projectChannelWorkStatus(
  item: ItemProgressPayload,
): ChannelProgressDraftLine | undefined {
  if (item.hideFromChannelProgress || item.suppressChannelProgress || !item.itemId) {
    return undefined;
  }
  const child = item.kind === "subagent";
  if (!child && !["tool", "command", "search", "api", "patch"].includes(item.kind ?? "")) {
    return undefined;
  }
  const state =
    item.status ??
    (child && (item.summary === "waiting" || item.summary === "outcome unknown")
      ? item.summary
      : undefined);
  if (
    !state ||
    ![
      "running",
      "completed",
      "failed",
      "blocked",
      "skipped",
      "waiting",
      "outcome unknown",
    ].includes(state)
  ) {
    return undefined;
  }
  const label = child
    ? item.title?.trim() || "Delegated work"
    : buildChannelProgressDraftLine({ event: "item", itemKind: item.kind, name: item.name })?.label;
  if (!label) {
    return undefined;
  }
  // A finished operation is not a finished task. Ordinary diagnostic outcomes
  // remain in the optional tool log; a child's terminal state matters to its wait.
  const text =
    child || state === "running" || state === "blocked"
      ? `${label}: ${state}`
      : `Last activity: ${label}`;
  return {
    id: item.itemId,
    kind: child ? "subagent-status" : "operation-status",
    label: "",
    text: redactToolPayloadText(text),
    // Bounded cards reserve lines for failures by status, ahead of plans and routine rows.
    ...(child ? { status: state } : {}),
    prefix: false,
  };
}
