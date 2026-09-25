// Formats subagent status rows for the status command response.
import type { TaskSummary } from "../../../packages/gateway-protocol/src/schema/tasks.js";
import type { ControlledSubagentRunsReadContext } from "../../agents/subagents/registry/subagent-control-scope.js";
import { hasSubagentRunEnded } from "../../agents/subagents/registry/subagent-run-liveness.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { sanitizeTaskStatusText } from "../../tasks/task-status.js";
import { formatRunLabel } from "./subagents-utils.js";

function formatExecutionObservation(observation: NonNullable<TaskSummary["execution"]>): string {
  switch (observation.state) {
    case "running": {
      const tool = sanitizeTaskStatusText(observation.currentTool?.name, { maxChars: 60 });
      return tool ? `running ${tool}` : "running";
    }
    case "queued":
      return "queued";
    case "waiting":
      switch (observation.wait?.kind) {
        case "approval":
          return "waiting for approval";
        case "user_input":
          return "waiting for input";
        case "children":
          return "waiting for child tasks";
        case "agent_messages":
          return "waiting for agent messages";
        default:
          return "waiting for external work";
      }
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
  let active = 0;
  let done = 0;
  const detailLines: string[] = [];
  for (const entry of context.runs) {
    const pendingDescendants = context.list.pendingDescendants.get(entry.childSessionKey) ?? 0;
    if (activeRuns.has(entry)) {
      active += 1;
      if (detailLines.length >= 3) {
        continue;
      }
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
      detailLines.push(`  • ${label} · ${duration} · ${executionText}${descendantText}`);
    } else if (hasSubagentRunEnded(entry) && pendingDescendants === 0) {
      done += 1;
    }
  }
  if (active === 0) {
    return verboseEnabled && done > 0 ? `🤖 Subagents: 0 active · ${done} done` : undefined;
  }

  const summary = `🤖 Subagents: ${active} active${done > 0 ? ` · ${done} done` : ""}`;
  return [summary, ...detailLines].join("\n");
}
