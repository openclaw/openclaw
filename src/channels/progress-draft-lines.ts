import { isShellToolDisplayName } from "../agents/tool-display.js";
export type ChannelProgressDraftLine = {
  /** Stable line id used to update an existing progress line in place. */
  id?: string;
  kind:
    | "tool"
    | "item"
    | "plan"
    | "approval"
    | "command-output"
    | "patch"
    | "operation-status"
    | "subagent-status";
  /** Rendered line text before final draft truncation/prefix formatting. */
  text: string;
  label: string;
  icon?: string;
  detail?: string;
  /** Optional lifecycle status, such as completed or exit code. */
  status?: string;
  /** Completion metadata for authored text; never rendered as a tool status. */
  complete?: boolean;
  /** Normalized tool name when the line represents tool work. */
  toolName?: string;
  /** Whether final formatting should add a bullet/line prefix. */
  prefix?: boolean;
};

type ProgressDraftLine = string | ChannelProgressDraftLine;

/**
 * Removes a keyed structured progress line while preserving plain text draft lines.
 * Returns the original array when no line is removed so renderers can use identity as a no-op signal.
 */
export function removeChannelProgressDraftLine<TLine extends ProgressDraftLine>(
  lines: TLine[],
  id: string,
): TLine[] {
  const lineId = id.trim();
  if (!lineId) {
    return lines;
  }
  const next = lines.filter((line) => typeof line !== "object" || line.id?.trim() !== lineId);
  // Reference equality is part of the caller contract; redraw/delete work only runs after a real removal.
  return next.length === lines.length ? lines : next;
}

/** Approvals and failures that can start a draft when their rows are visible. */
export function isChannelProgressAttentionLine(line: string | ChannelProgressDraftLine): boolean {
  if (typeof line === "string") {
    return false;
  }
  const status = line.status?.toLowerCase();
  return (
    line.kind === "approval" ||
    status === "failed" ||
    status === "error" ||
    status === "blocked" ||
    (status?.startsWith("exit ") === true && status !== "exit 0")
  );
}

/** Lines that reserve bounded progress capacity in active tool-log drafts. */
export function isChannelProgressPriorityLine(line: string | ChannelProgressDraftLine): boolean {
  if (typeof line === "string") {
    return false;
  }
  const status = line.status?.toLowerCase();
  if (line.kind === "item" && status === "failed" && Boolean(line.toolName?.trim())) {
    return false;
  }
  return (
    line.kind === "approval" || status === "failed" || status === "error" || status === "blocked"
  );
}

export function getProgressDraftLineText(line: string | ChannelProgressDraftLine): string {
  if (typeof line === "string") {
    return line;
  }
  const icon = line.icon?.trim();
  const prefix = icon ? `${icon} ` : "";
  const label = line.label.trim();
  const detail = line.detail?.trim();
  const status = line.status?.trim();
  const displayStatus = status === "completed" ? undefined : status;
  if (detail) {
    const compactCommandLine = isShellToolDisplayName(line.toolName);
    const showStatus =
      displayStatus &&
      detail !== displayStatus &&
      (line.kind === "command-output" || isChannelProgressAttentionLine(line));
    const text =
      showStatus && !detail.startsWith(`${displayStatus};`)
        ? `${displayStatus}; ${detail}`
        : detail;
    return label && !compactCommandLine && (showStatus || line.kind !== "patch")
      ? `${prefix}${label}: ${text}`
      : `${prefix}${text}`;
  }
  if (displayStatus) {
    // A label-less status row already carries its status in its prepared text.
    return label
      ? `${prefix}${label}: ${displayStatus}`
      : line.text.trim() || `${prefix}${displayStatus}`;
  }
  const text = line.text.trim();
  if (!icon && text && text !== label) {
    return text;
  }
  return `${prefix}${label}`.trim();
}
