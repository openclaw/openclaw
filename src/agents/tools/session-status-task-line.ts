import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildTaskStatusSnapshotForRelatedSessionKeyForOwner } from "../../tasks/task-owner-access.js";
import {
  formatTaskStatus,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
} from "../../tasks/task-status.js";

export function formatSessionTaskLine(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
  callerAgentId: string;
  config: OpenClawConfig;
}): string | undefined {
  const snapshot = buildTaskStatusSnapshotForRelatedSessionKeyForOwner({
    relatedSessionKey: params.relatedSessionKey,
    callerOwnerKey: params.callerOwnerKey,
    callerAgentId: params.callerAgentId,
    config: params.config,
  });
  const task = snapshot.focus;
  if (!task) {
    return undefined;
  }
  const headline =
    snapshot.activeCount > 0
      ? `${snapshot.activeCount} active`
      : snapshot.recentFailureCount > 0
        ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}`
        : `latest ${formatTaskStatus(task).replaceAll("_", " ")}`;
  const title = formatTaskStatusTitle(task);
  const detail = formatTaskStatusDetail(task);
  const blocked = formatTaskStatus(task) === "blocked" ? "blocked" : undefined;
  const parts = [headline, blocked, task.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}
