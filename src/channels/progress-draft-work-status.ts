import type { ItemProgressPayload } from "./progress-draft-events.js";
import type { ChannelProgressDraftLine } from "./progress-draft-lines.js";
import { buildChannelProgressDraftLine, type ChannelProgressLineOptions } from "./streaming.js";

/** Status is not a tool log: never project arguments, command titles or result prose. */
export function projectChannelWorkStatus(
  item: ItemProgressPayload,
  options?: Pick<ChannelProgressLineOptions, "toolIcons">,
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
  if (child) {
    // A child's terminal state matters to its wait, so every state stays visible.
    return {
      id: item.itemId,
      kind: "subagent-status",
      label: "",
      text: `${item.title?.trim() || "Delegated work"}: ${state}`,
      // Bounded cards reserve lines for failures by status, ahead of plans and routine rows.
      status: state,
      prefix: false,
    };
  }
  // The tool log's own row, reduced to its name, so both views render alike.
  const row = buildChannelProgressDraftLine(
    { event: "item", itemKind: item.kind, name: item.name },
    { toolIcons: options?.toolIcons },
  );
  if (!row?.label) {
    return undefined;
  }
  return {
    id: item.itemId,
    kind: "operation-status",
    label: row.label,
    text: row.label,
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.toolName ? { toolName: row.toolName } : {}),
    // A finished operation is not a finished task, and ordinary diagnostic
    // outcomes belong to the optional tool log: only live states are shown.
    ...(state === "running" || state === "blocked" ? { status: state } : {}),
    prefix: false,
  };
}
