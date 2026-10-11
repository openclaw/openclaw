import { sanitizeRunStatusText } from "../../agents/run-status-text.js";
import type { ControlledSubagentRunsReadContext } from "../../agents/subagents/registry/subagent-control-scope.js";
// Formats subagent status rows for the status command response.
import type { SubagentExecutionObservation } from "../../agents/subagents/registry/subagent-execution-observation.js";
import { hasSubagentRunEnded } from "../../agents/subagents/registry/subagent-run-liveness.js";
import { resolveSubagentSessionStatus } from "../../agents/subagents/registry/subagent-session-metrics.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { formatRunLabel } from "./subagents-utils.js";

const WAIT_LABELS = new Map([
  ["approval", "approval"],
  ["user_input", "input"],
  ["agent_messages", "agent messages"],
  ["children", "child tasks"],
]);

function formatExecutionObservation(observation: SubagentExecutionObservation): string {
  switch (observation.state) {
    case "running": {
      const tool = sanitizeRunStatusText(observation.currentTool?.name, { maxChars: 60 });
      return tool ? `running ${tool}` : "running";
    }
    case "queued":
      return "queued";
    case "waiting":
      return `waiting for ${WAIT_LABELS.get(observation.wait?.kind ?? "") ?? "external work"}`;
    case "finished":
      return "finished · settlement pending";
    default:
      return "current activity unavailable";
  }
}

/** Builds the compact status line from the controller's ordered snapshot and descendant index. */
export function buildSubagentsStatusLine(params: {
  context: ControlledSubagentRunsReadContext;
  verboseEnabled: boolean;
  now?: number;
}): string | undefined {
  const { context, verboseEnabled } = params;
  if (context.runs.length === 0) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const activeRuns = new Set(context.list.view.active);
  const active = activeRuns.size;
  const endedCounts = {
    done: 0,
    failed: 0,
    "timed out": 0,
    cancelled: 0,
    interrupted: 0,
    ended: 0,
    "delivery pending": 0,
    "delivery blocked": 0,
  };
  for (const entry of context.runs) {
    const pendingDescendants = context.list.pendingDescendants.get(entry.childSessionKey) ?? 0;
    if (!activeRuns.has(entry) && hasSubagentRunEnded(entry) && pendingDescendants === 0) {
      // Steer replacement is an internal restart, not user cancellation.
      const status = resolveSubagentSessionStatus(
        entry.suppressAnnounceReason === "steer-restart"
          ? { ...entry, endedReason: undefined }
          : entry,
      );
      if (status === "killed") {
        endedCounts.cancelled += 1;
      } else if (status === "interrupted") {
        endedCounts.interrupted += 1;
      } else if (status === "failed") {
        endedCounts.failed += 1;
      } else if (status === "timeout") {
        endedCounts["timed out"] += 1;
      } else if (status === "done" && entry.execution.outcome?.status === "ok") {
        endedCounts.done += 1;
      } else {
        endedCounts.ended += 1;
      }

      const deliveryStatus = entry.delivery?.status;
      if (deliveryStatus === "pending" || deliveryStatus === "in_progress") {
        endedCounts["delivery pending"] += 1;
      } else if (deliveryStatus === "failed" || deliveryStatus === "suspended") {
        endedCounts["delivery blocked"] += 1;
      }
    }
  }
  const endedParts = Object.entries(endedCounts)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`);

  if (active === 0) {
    return verboseEnabled && endedParts.length > 0
      ? `🤖 Subagents: 0 active · ${endedParts.join(" · ")}`
      : undefined;
  }
  const detailLines = [...activeRuns].slice(0, 3).map((entry) => {
    const pendingDescendants = context.list.pendingDescendants.get(entry.childSessionKey) ?? 0;
    const startedAt = entry.execution.startedAt ?? entry.sessionStartedAt ?? entry.createdAt;
    const durationMs = Math.max(
      0,
      (entry.execution.endedAt && pendingDescendants === 0 ? entry.execution.endedAt : now) -
        startedAt,
    );
    const duration = formatDurationCompact(durationMs, { spaced: true }) ?? "0s";
    const label = formatRunLabel(entry, { maxLength: 56 });
    const executionText = formatExecutionObservation(context.getExecutionObservation(entry));
    const descendantText =
      pendingDescendants > 0
        ? ` · ${pendingDescendants} child${pendingDescendants === 1 ? "" : "ren"} pending`
        : "";
    return `  • ${label} · ${duration} · ${executionText}${descendantText}`;
  });

  const summary = `🤖 Subagents: ${active} active${endedParts.length > 0 ? ` · ${endedParts.join(" · ")}` : ""}`;
  return [summary, ...detailLines].join("\n");
}
