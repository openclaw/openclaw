// Formats subagent status rows for the status command response.
import type { buildControlledSubagentRunsReadContext } from "../../agents/subagents/registry/subagent-control-scope.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../../agents/subagents/registry/subagent-lifecycle-events.js";
import {
  hasSubagentRunEnded,
  isRetainedUnendedSubagentRun,
} from "../../agents/subagents/registry/subagent-run-liveness.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { formatRunLabel } from "./subagents-utils.js";

/** Builds the compact status line from the controller's ordered snapshot and descendant index. */
export function buildSubagentsStatusLine(params: {
  context: ReturnType<typeof buildControlledSubagentRunsReadContext>;
  verboseEnabled: boolean;
  now?: number;
}): string | undefined {
  const { context, verboseEnabled } = params;
  if (context.runs.length === 0) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  let active = 0;
  const endedCounts = {
    done: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0,
    ended: 0,
    deliveryPending: 0,
    deliveryBlocked: 0,
  };
  const detailLines: string[] = [];
  for (const entry of context.runs) {
    const pendingDescendants = context.countPendingDescendantRuns(entry.childSessionKey);
    if (isRetainedUnendedSubagentRun(entry, now) || pendingDescendants > 0) {
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
      const descendantText =
        pendingDescendants > 0
          ? ` · ${pendingDescendants} child${pendingDescendants === 1 ? "" : "ren"} active`
          : "";
      detailLines.push(`  • ${label} · ${duration}${descendantText}`);
    } else if (hasSubagentRunEnded(entry) && pendingDescendants === 0) {
      const outcomeStatus = entry.execution.outcome?.status;
      if (
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        entry.suppressAnnounceReason !== "steer-restart"
      ) {
        endedCounts.cancelled += 1;
      } else if (outcomeStatus === "ok") {
        endedCounts.done += 1;
      } else if (outcomeStatus === "timeout") {
        endedCounts.timedOut += 1;
      } else if (outcomeStatus === "error") {
        endedCounts.failed += 1;
      } else {
        endedCounts.ended += 1;
      }

      const deliveryStatus = entry.delivery?.status;
      if (deliveryStatus === "pending" || deliveryStatus === "in_progress") {
        endedCounts.deliveryPending += 1;
      } else if (deliveryStatus === "failed" || deliveryStatus === "suspended") {
        endedCounts.deliveryBlocked += 1;
      }
    }
  }
  const endedParts = formatEndedCounts(endedCounts);
  if (active === 0) {
    return verboseEnabled && endedParts.length > 0
      ? `🤖 Subagents: 0 active · ${endedParts.join(" · ")}`
      : undefined;
  }

  const summary = `🤖 Subagents: ${active} active${endedParts.length > 0 ? ` · ${endedParts.join(" · ")}` : ""}`;
  return [summary, ...detailLines].join("\n");
}

function formatEndedCounts(counts: {
  done: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  ended: number;
  deliveryPending: number;
  deliveryBlocked: number;
}): string[] {
  return [
    formatCount(counts.done, "done"),
    formatCount(counts.failed, "failed"),
    formatCount(counts.timedOut, "timed out"),
    formatCount(counts.cancelled, "cancelled"),
    formatCount(counts.ended, "ended"),
    formatCount(counts.deliveryPending, "delivery pending"),
    formatCount(counts.deliveryBlocked, "delivery blocked"),
  ].filter((part): part is string => part !== undefined);
}

function formatCount(count: number, label: string): string | undefined {
  return count > 0 ? `${count} ${label}` : undefined;
}
